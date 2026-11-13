<?php
/**
 * Shared parsing primitives for the spreadsheet importers.
 *
 * Extracted from attendance-import.php when the grades importer was added, so
 * the two do not carry separate copies of the delimiter sniffing, the
 * SpreadsheetML reader and the header-matching rules. Anything here is pure —
 * no session, no database, no output — so it can be unit-tested directly.
 *
 * attendance-import.php kept its own `attimport_` copies until 2026-09-25; they
 * were identical to these and now it calls these.
 */

if (!defined('SHEETIMPORT_MAX_BYTES')) {
    define('SHEETIMPORT_MAX_BYTES', 5 * 1024 * 1024); // 5 MB
    define('SHEETIMPORT_MAX_ROWS', 5000);
    define('SHEETIMPORT_SAMPLE_LIMIT', 100); // cap detail lists returned to the client
}

/**
 * Buffers rows and writes them as multi-row INSERT ... ON DUPLICATE KEY UPDATE.
 *
 * The importers used to run one execute() per row. Everything else about them
 * was already tight - a single transaction, statements prepared once, lookups
 * preloaded into maps - so what remained was 5,000 round trips to MySQL, and
 * that was 93% of a 5,000-row import. Measured on this machine: 1,154 ms of
 * per-row executes became 125 ms batched, taking the whole import from 1.24 s
 * to 0.21 s.
 *
 * Only the write is batched. Validation, student matching and the
 * inserted-vs-updated tally all happen in PHP before a row gets here, reading
 * sets the importer preloaded, so no count or error message changes.
 *
 * Callers must flush() before committing; add() only writes when the buffer
 * fills. Column names are interpolated, so pass literals - already backticked
 * where a name is reserved, as `date` is.
 */
final class SheetImportBatchWriter
{
    private PDO $pdo;
    private string $table;
    private array $columns;
    private string $updateClause;
    private int $batchSize;
    private array $buffer = [];
    private ?PDOStatement $fullStatement = null;
    private int $written = 0;

    public function __construct(PDO $pdo, string $table, array $columns, string $updateClause, int $batchSize = 500)
    {
        $this->pdo = $pdo;
        $this->table = $table;
        $this->columns = array_values($columns);
        $this->updateClause = $updateClause;
        // A prepared statement takes at most 65,535 placeholders. Staying an
        // order of magnitude below that keeps a wide table from silently
        // becoming the one case that fails.
        $perRow = max(1, count($this->columns));
        $this->batchSize = max(1, min($batchSize, intdiv(60000, $perRow)));
    }

    private function sql(int $rowCount): string
    {
        $tuple = '(' . implode(',', array_fill(0, count($this->columns), '?')) . ')';
        return 'INSERT INTO ' . $this->table . ' (' . implode(', ', $this->columns) . ')'
             . ' VALUES ' . implode(',', array_fill(0, $rowCount, $tuple))
             . ' ON DUPLICATE KEY UPDATE ' . $this->updateClause;
    }

    /** Values positionally in the column order given to the constructor. */
    public function add(array $values): void
    {
        if (count($values) !== count($this->columns)) {
            throw new InvalidArgumentException('Row has ' . count($values) . ' values, expected ' . count($this->columns));
        }
        $this->buffer[] = array_values($values);
        if (count($this->buffer) >= $this->batchSize) {
            $this->flush();
        }
    }

    public function flush(): void
    {
        $rowCount = count($this->buffer);
        if ($rowCount === 0) return;

        // Full batches all share one statement; only the final short one needs
        // its own prepare.
        if ($rowCount === $this->batchSize) {
            if ($this->fullStatement === null) {
                $this->fullStatement = $this->pdo->prepare($this->sql($this->batchSize));
            }
            $stmt = $this->fullStatement;
        } else {
            $stmt = $this->pdo->prepare($this->sql($rowCount));
        }

        $params = [];
        foreach ($this->buffer as $row) {
            foreach ($row as $value) $params[] = $value;
        }
        $stmt->execute($params);

        $this->written += $rowCount;
        $this->buffer = [];
    }

    public function written(): int
    {
        return $this->written;
    }
}

/**
 * Normalize a header cell to a comparison key: lowercase, alphanumerics only.
 * A literal "%" becomes "percent" first so "Passed %" does not collapse onto
 * the "Passed" count column.
 */
function sheetimport_header_key(string $value): string {
    $value = str_replace('%', 'percent', strtolower(trim($value)));
    return preg_replace('/[^a-z0-9]/', '', $value);
}

/**
 * Parse a whole-number cell that may carry commas, spaces or a trailing % sign.
 *
 * THE DECIMAL POINT IS PART OF THE NUMBER, NOT PUNCTUATION TO STRIP.
 *
 * This used to delete every character that was not a digit or a minus, which
 * silently multiplies any cell written with decimal places. A registrar export
 * that formats counts to two places -- ordinary Excel column formatting --
 * turned 8 subjects into 800 and 23 classes into 230. Demonstrated end to end
 * on 2026-09-22: the upload answered HTTP 200, "Import complete", with zero
 * warnings, because the row still reconciled perfectly (600 + 200 = 800).
 * Every count on the sheet was scaled by the same factor, so the one check
 * that could have caught it agreed with itself.
 *
 * A cell with a REAL fraction (3.7 subjects) is refused rather than rounded.
 * These columns count things, so a fraction means the column is not what we
 * think it is, and the caller already reports a null as an invalid row with
 * the student number attached. Rounding it would be the same silent guess in
 * a smaller disguise.
 *
 * The shape is validated after stripping rather than trusted: "1-2" survived
 * as 1 before, and "8.0.1" would now survive as nothing useful.
 */
function sheetimport_to_int(string $value): ?int {
    // Keep the decimal point. Commas, spaces, currency and % still go.
    $clean = preg_replace('/[^0-9.\-]/', '', $value);
    if (!preg_match('/^-?\d+(\.\d+)?$/', $clean)) {
        return null;
    }
    if (strpos($clean, '.') === false) {
        return (int)$clean;
    }

    // "8.00" is 8 written with formatting; "3.7" is not a count.
    $number = (float)$clean;
    return $number === floor($number) ? (int)$number : null;
}

/** Detect the most likely delimiter from a header line. */
function sheetimport_detect_delimiter(string $line): string {
    $candidates = [',' => substr_count($line, ','), "\t" => substr_count($line, "\t"), ';' => substr_count($line, ';')];
    arsort($candidates);
    $best = array_key_first($candidates);
    return $candidates[$best] > 0 ? $best : ',';
}

/** Parse CSV / delimited text into a list of rows (each row = array of string cells). */
function sheetimport_parse_csv(string $content): array {
    if (strncmp($content, "\xEF\xBB\xBF", 3) === 0) {
        $content = substr($content, 3);
    }
    $content = str_replace(["\r\n", "\r"], "\n", $content);
    $firstLine = strtok($content, "\n");
    $delimiter = sheetimport_detect_delimiter($firstLine === false ? '' : $firstLine);

    $rows = [];
    $stream = fopen('php://temp', 'r+');
    fwrite($stream, $content);
    rewind($stream);
    while (($cells = fgetcsv($stream, 0, $delimiter)) !== false) {
        if ($cells === [null] || (count($cells) === 1 && trim((string)$cells[0]) === '')) {
            continue;
        }
        $rows[] = array_map(static fn($c) => (string)($c ?? ''), $cells);
    }
    fclose($stream);
    return $rows;
}

/** Parse a SpreadsheetML (Excel 2003 XML) workbook into a list of rows. */
function sheetimport_parse_spreadsheetml(string $content): array {
    $previous = libxml_use_internal_errors(true);
    $xml = simplexml_load_string($content);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);
    if ($xml === false) {
        return [];
    }

    $ss = 'urn:schemas-microsoft-com:office:spreadsheet';
    $rows = [];
    foreach ($xml->children($ss)->Worksheet as $worksheet) {
        foreach ($worksheet->children($ss)->Table->Row as $rowNode) {
            $cells = [];
            $colIndex = 0; // 0-based cursor
            foreach ($rowNode->children($ss)->Cell as $cellNode) {
                $attrs = $cellNode->attributes($ss);
                if (isset($attrs->Index)) {
                    $colIndex = ((int)$attrs->Index) - 1; // ss:Index is 1-based
                }
                $cells[$colIndex] = isset($cellNode->children($ss)->Data)
                    ? (string)$cellNode->children($ss)->Data
                    : '';
                $colIndex++;
            }
            if (empty($cells)) {
                continue;
            }
            // Densify (fill gaps left by ss:Index) so header alignment stays stable.
            $max = max(array_keys($cells));
            $dense = [];
            for ($i = 0; $i <= $max; $i++) {
                $dense[$i] = $cells[$i] ?? '';
            }
            $rows[] = $dense;
        }
        break; // first worksheet only
    }
    return $rows;
}

/** Pick the right reader for the uploaded bytes. */
function sheetimport_parse(string $content): array {
    $probe = ltrim(substr($content, 0, 512));
    if (
        stripos($probe, '<?xml') === 0
        || stripos($content, '<Workbook') !== false
        || stripos($content, 'urn:schemas-microsoft-com:office:spreadsheet') !== false
    ) {
        return sheetimport_parse_spreadsheetml($content);
    }
    return sheetimport_parse_csv($content);
}

/**
 * Find the header row and map each canonical field to its column index.
 *
 * The header is searched for rather than assumed to be row 1, because exported
 * sheets routinely carry a title and a blank line above it.
 *
 * @param array<int, array<int, string>> $rows
 * @param array<string, string> $headerMap normalized header key => field name
 * @param string[] $requiredFields fields that must all be present
 * @return array{0: int|null, 1: array<string, int>} [header row index, field => column]
 */
function sheetimport_locate_header(array $rows, array $headerMap, array $requiredFields): array {
    foreach ($rows as $index => $row) {
        $candidate = [];
        foreach ($row as $colIndex => $cell) {
            $key = sheetimport_header_key((string)$cell);
            $field = $headerMap[$key] ?? null;
            if ($field !== null && !isset($candidate[$field])) {
                $candidate[$field] = $colIndex;
            }
        }

        $hasAll = true;
        foreach ($requiredFields as $field) {
            if (!isset($candidate[$field])) {
                $hasAll = false;
                break;
            }
        }

        if ($hasAll) {
            return [$index, $candidate];
        }
    }

    return [null, []];
}

/**
 * Validate an uploaded file and return its contents.
 *
 * @return array{0: string|null, 1: string|null} [content, error message]
 */
function sheetimport_read_upload(?array $file): array {
    if (!is_array($file)) {
        return [null, 'No file was uploaded. Attach a CSV or Excel (.xls) file.'];
    }
    $errorCode = $file['error'] ?? UPLOAD_ERR_NO_FILE;
    if ($errorCode !== UPLOAD_ERR_OK) {
        return [null, ($errorCode === UPLOAD_ERR_INI_SIZE || $errorCode === UPLOAD_ERR_FORM_SIZE)
            ? 'The file is too large.'
            : 'The file failed to upload. Please try again.'];
    }
    if (($file['size'] ?? 0) > SHEETIMPORT_MAX_BYTES) {
        return [null, 'The file exceeds the 5 MB limit.'];
    }
    if (!is_uploaded_file($file['tmp_name'] ?? '')) {
        return [null, 'Invalid upload.'];
    }

    $content = file_get_contents($file['tmp_name']);
    if ($content === false || trim($content) === '') {
        return [null, 'The uploaded file is empty.'];
    }

    // Binary .xlsx is a ZIP container; the zip extension is unavailable here.
    if (strncmp($content, "PK\x03\x04", 4) === 0) {
        return [null, 'Binary .xlsx files are not supported. Please re-save the file as CSV (Comma delimited) and upload again.'];
    }

    return [$content, null];
}

<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/periodic_lib.php';
// The Potential Drop Out filter. The priority rules live there and are not
// restated here — see pdo_filter_student_ids().
require_once __DIR__ . '/pdo_priority_lib.php';



function attendance_get_int_param(array $source, string $key): ?int {
    if (!isset($source[$key]) || $source[$key] === '') return null;
    $value = (int)$source[$key];
    return $value > 0 ? $value : null;
}

function attendance_trim_param(array $source, string $key): string {
    return isset($source[$key]) ? trim((string)$source[$key]) : '';
}

function attendance_is_date(string $value): bool {
    if ($value === '') return false;
    $date = DateTime::createFromFormat('Y-m-d', $value);
    return $date && $date->format('Y-m-d') === $value;
}

function attendance_escape_csv_cell($value): string {
    return (string)($value ?? '');
}

function attendance_export_rows(array $rows): array {
    return array_map(static function (array $row): array {
        return [
            'student_id' => attendance_escape_csv_cell($row['student_id'] ?? ''),
            'student_name' => attendance_escape_csv_cell($row['student_name'] ?? ''),
            'total_classes_conducted' => (int)($row['total_classes_conducted'] ?? 0),
            'present' => (int)($row['present'] ?? 0),
            'absent' => (int)($row['absent'] ?? 0),
            'present_percentage' => number_format((float)($row['present_percentage'] ?? 0), 2) . '%',
            'absent_percentage' => number_format((float)($row['absent_percentage'] ?? 0), 2) . '%',
            /*
             * 0.00% where a periodical holds nothing for this student, matching
             * what the table shows.
             *
             * Worth knowing when these are averaged in a spreadsheet: an
             * unrecorded periodical now contributes a zero rather than being
             * skipped, so an average over a column where P3 has not been
             * uploaded yet is an average over zeroes, not over the students who
             * have data. Filter the column before averaging it.
             */
            'p1_rate' => attendance_export_rate($row, 1),
            'p2_rate' => attendance_export_rate($row, 2),
            'p3_rate' => attendance_export_rate($row, 3),
        ];
    }, $rows);
}

/**
 * One periodical's attendance rate for an export cell.
 *
 * A periodical with nothing uploaded reads as 0.00%, matching the screen. A
 * blank was the more precise statement - "no data" and "attended nothing" are
 * different facts - but an export whose P1 column is empty on every row early
 * in a semester is read as a failed export rather than as an honest gap.
 */
function attendance_export_rate(array $row, int $period): string
{
    $rate = $row['p' . $period . '_rate'] ?? null;
    return number_format((float)$rate, 2) . '%';
}

/**
 * A cell Excel will treat as text, not as a formula to run.
 *
 * fputcsv() quotes and escapes correctly for the CSV *format*, and that is not
 * the same problem. A spreadsheet reads a leading =, +, - or @ as the start of a
 * formula, so a student whose name was stored as
 * `=HYPERLINK("http://evil","Click")` becomes a live link in every exported
 * sheet -- and DDE payloads in the same position can reach the shell. Nothing
 * about the file is malformed; the name simply arrives as code.
 *
 * The leading apostrophe is the standard defusal: Excel strips it on display
 * and the cell reads as the text it always was.
 *
 * shared/lib/spreadsheet.js does exactly this for the exports the browser
 * builds. This is the one export rendered server-side, and it was missed.
 */
function attendance_csv_cell($value): string
{
    $text = (string)($value ?? '');
    return preg_match('/^[=+\-@\t\r]/', $text) === 1 ? "'" . $text : $text;
}

function attendance_send_csv(array $rows): void {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="attendance-summary.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['Student ID', 'Student Name', 'Total Classes Conducted', 'Present', 'Absent', 'Present %', 'Absent %', 'P1 %', 'P2 %', 'P3 %']);
    foreach (attendance_export_rows($rows) as $row) {
        fputcsv($out, array_map('attendance_csv_cell', array_values($row)));
    }
    fclose($out);
    exit;
}

function attendance_xml($value): string {
    return htmlspecialchars((string)($value ?? ''), ENT_QUOTES | ENT_XML1, 'UTF-8');
}

function attendance_send_excel(array $rows): void {
    header('Content-Type: application/vnd.ms-excel; charset=utf-8');
    header('Content-Disposition: attachment; filename="attendance-summary.xls"');

    $columns = [
        ['key' => 'student_id', 'label' => 'Student ID'],
        ['key' => 'student_name', 'label' => 'Student Name'],
        ['key' => 'total_classes_conducted', 'label' => 'Total Classes Conducted'],
        ['key' => 'present', 'label' => 'Present'],
        ['key' => 'absent', 'label' => 'Absent'],
        ['key' => 'present_percentage', 'label' => 'Present %'],
        ['key' => 'absent_percentage', 'label' => 'Absent %'],
        ['key' => 'p1_rate', 'label' => 'P1 %'],
        ['key' => 'p2_rate', 'label' => 'P2 %'],
        ['key' => 'p3_rate', 'label' => 'P3 %'],
    ];
    $exportRows = attendance_export_rows($rows);

    echo '<?xml version="1.0"?>' . "\n";
    echo '<?mso-application progid="Excel.Sheet"?>' . "\n";
    echo '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ';
    echo 'xmlns:o="urn:schemas-microsoft-com:office:office" ';
    echo 'xmlns:x="urn:schemas-microsoft-com:office:excel" ';
    echo 'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' . "\n";
    echo '<Worksheet ss:Name="Attendance Summary"><Table>' . "\n";
    echo '<Row>';
    foreach ($columns as $column) {
        echo '<Cell><Data ss:Type="String">' . attendance_xml($column['label']) . '</Data></Cell>';
    }
    echo '</Row>' . "\n";

    foreach ($exportRows as $row) {
        echo '<Row>';
        foreach ($columns as $column) {
            echo '<Cell><Data ss:Type="String">' . attendance_xml($row[$column['key']] ?? '') . '</Data></Cell>';
        }
        echo '</Row>' . "\n";
    }

    echo '</Table></Worksheet></Workbook>';
    exit;
}

function attendance_pdf_escape(string $value): string {
    return str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $value);
}

function attendance_pdf_line(array $values, array $widths): string {
    $parts = [];
    foreach ($values as $index => $value) {
        $width = $widths[$index] ?? 12;
        $text = preg_replace('/\s+/', ' ', trim((string)$value));
        if (strlen($text) > $width) {
            $text = substr($text, 0, max(0, $width - 3)) . '...';
        }
        $parts[] = str_pad($text, $width);
    }
    return implode(' ', $parts);
}

/*
 * Seven columns, not ten.
 *
 * The CSV and the Excel sheet carry the P1/P2/P3 breakdown; this one cannot.
 * It is a fixed-pitch layout already 95 characters wide, and three more columns
 * put it at 119 - past the page, at which point attendance_pdf_line() starts
 * truncating student names to fit. A printout that cannot be read by name is
 * worth less than one without the breakdown.
 */
function attendance_send_pdf(array $rows): void {
    $headers = ['Student ID', 'Student Name', 'Total', 'Present', 'Absent', 'Present %', 'Absent %'];
    $widths = [14, 28, 8, 8, 8, 10, 10];
    $lines = [
        'Attendance Summary',
        attendance_pdf_line($headers, $widths),
        str_repeat('-', 95),
    ];

    foreach (attendance_export_rows($rows) as $row) {
        $lines[] = attendance_pdf_line([
            $row['student_id'],
            $row['student_name'],
            $row['total_classes_conducted'],
            $row['present'],
            $row['absent'],
            $row['present_percentage'],
            $row['absent_percentage'],
        ], $widths);
    }

    $linesPerPage = 42;
    $pages = array_chunk($lines, $linesPerPage);
    if (empty($pages)) {
        $pages = [['Attendance Summary']];
    }

    $objects = [];
    $objects[] = '<< /Type /Catalog /Pages 2 0 R >>';
    $pageKids = [];
    $fontObjectNumber = 3 + (count($pages) * 2);

    foreach ($pages as $index => $pageLines) {
        $pageObjectNumber = 3 + ($index * 2);
        $contentObjectNumber = $pageObjectNumber + 1;
        $pageKids[] = $pageObjectNumber . ' 0 R';
        $objects[$pageObjectNumber - 1] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 ' . $fontObjectNumber . ' 0 R >> >> /Contents ' . $contentObjectNumber . ' 0 R >>';

        $content = "BT\n/F1 8 Tf\n1 0 0 1 36 570 Tm\n";
        foreach ($pageLines as $line) {
            $content .= '(' . attendance_pdf_escape($line) . ") Tj\n0 -12 Td\n";
        }
        $content .= "ET\n";
        $objects[$contentObjectNumber - 1] = '<< /Length ' . strlen($content) . " >>\nstream\n" . $content . "endstream";
    }

    $objects[1] = '<< /Type /Pages /Kids [' . implode(' ', $pageKids) . '] /Count ' . count($pages) . ' >>';
    $objects[$fontObjectNumber - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
    ksort($objects);

    $pdf = "%PDF-1.4\n";
    $offsets = [0];
    foreach ($objects as $index => $object) {
        $offsets[$index + 1] = strlen($pdf);
        $pdf .= ($index + 1) . " 0 obj\n" . $object . "\nendobj\n";
    }

    $xrefOffset = strlen($pdf);
    $pdf .= "xref\n0 " . (count($objects) + 1) . "\n";
    $pdf .= "0000000000 65535 f \n";
    for ($i = 1; $i <= count($objects); $i += 1) {
        $pdf .= str_pad((string)($offsets[$i] ?? 0), 10, '0', STR_PAD_LEFT) . " 00000 n \n";
    }
    $pdf .= "trailer\n<< /Size " . (count($objects) + 1) . " /Root 1 0 R >>\n";
    $pdf .= "startxref\n" . $xrefOffset . "\n%%EOF";

    header('Content-Type: application/pdf');
    header('Content-Disposition: attachment; filename="attendance-summary.pdf"');
    header('Content-Length: ' . strlen($pdf));
    echo $pdf;
    exit;
}

function attendance_build_query(PDO $pdo, array $query): array {
    foreach (['student', 'attendance', 'status', 'course', 'department', 'semester', 'school_year'] as $table) {
        api_require_table($pdo, $table);
    }

    $studentHasArchivedAt = api_column_exists($pdo, 'student', 'archived_at');
    $search = attendance_trim_param($query, 'search');
    $section = attendance_trim_param($query, 'section');
    $courseId = attendance_get_int_param($query, 'course_id');
    $programId = attendance_get_int_param($query, 'program_id') ?? attendance_get_int_param($query, 'department_id');
    // Third step of the Reports scope chain. Course and department were already
    // here; year level is what lets the chain narrow all the way down.
    $yearLevel = attendance_get_int_param($query, 'year_level');
    /*
     * Campus, the step above department in the Reports scope chain.
     *
     * Narrowing only, never widening: it is applied on top of whatever
     * department rule already ran, so a pinned viewer asking for another
     * campus gets nothing rather than a way across the boundary. Expressed
     * through department because this query joins course, not department.
     */
    $campusId = attendance_get_int_param($query, 'campus_id');

    /*
     * A dean sees their own department and no other, whatever program_id or
     * department_id the query string asks for. Same rule finance-summary.php
     * and overview_analytics.php already apply.
     *
     * This endpoint had no department rule at all, so a dean calling it — or
     * exporting from it — got every student in the college. The UI never
     * offered them the choice, but the parameter is just a URL and the report
     * export reads the same endpoint, so the omission was reachable both by
     * hand and by accident.
     *
     * $authUser is read here rather than reused from further down, because the
     * scope has to be decided before the WHERE clause is built.
     */
    $scopeUser = api_get_session_user();
    if (api_user_is_department_pinned($scopeUser)) {
        // Assigned straight onto the variable the WHERE clause below binds, with
        // no intermediate. The first version put it in $ownDepartment and copied
        // it across on the next line, which reads the same but is not: deleting
        // that one copy left the session department read and then discarded, and
        // the query fell back to whatever the URL asked for.
        $programId = (int)($scopeUser['department_id'] ?? 0);
        if ($programId <= 0) {
            api_out(400, ['message' => 'Dean account is not linked to a department']);
        }
    }
    $semesterId = attendance_get_int_param($query, 'semester_id');
    $schoolYearId = attendance_get_int_param($query, 'school_year_id') ?? attendance_get_int_param($query, 'schoolyear_id');
    $dateFrom = attendance_trim_param($query, 'date_from');
    $dateTo = attendance_trim_param($query, 'date_to');
    $includeArchived = api_bool_like($query['include_archived'] ?? null, false);
    /*
     * Which periodical to count: 1, 2, 3, 'term' for the semester-total rows, or
     * absent for all of them together.
     *
     * With no period chosen this page already reports the semester total, because
     * every row it finds for a student is summed. Choosing P2 narrows that sum to
     * the second periodical.
     */
    $period = isset($query['period']) ? trim((string)$query['period']) : '';
    // One upload, from the list attendance_upload_options() returns.
    $uploadId = attendance_get_int_param($query, 'upload_id');

    if ($dateFrom !== '' && !attendance_is_date($dateFrom)) {
        api_out(400, ['message' => 'date_from must use YYYY-MM-DD']);
    }
    if ($dateTo !== '' && !attendance_is_date($dateTo)) {
        api_out(400, ['message' => 'date_to must use YYYY-MM-DD']);
    }

    $studentWhereParts = [];
    $attendanceJoinParts = ['a.student_id = st.student_id'];
    $params = [];

    if ($studentHasArchivedAt && !$includeArchived) {
        $studentWhereParts[] = 'st.archived_at IS NULL';
    }
    if ($search !== '') {
        $studentWhereParts[] = '(
            st.student_number LIKE :search
            OR st.first_name LIKE :search
            OR st.last_name LIKE :search
            OR st.middle_name LIKE :search
            OR CONCAT_WS(" ", st.first_name, st.middle_name, st.last_name) LIKE :search
            OR CONCAT_WS(" ", st.first_name, st.last_name) LIKE :search
            OR CONCAT_WS(" ", st.last_name, st.first_name) LIKE :search
        )';
        $params[':search'] = '%' . $search . '%';
    }
    if ($section !== '') {
        $studentWhereParts[] = 'st.section = :section';
        $params[':section'] = $section;
    }
    if ($courseId !== null) {
        $studentWhereParts[] = 'st.course_id = :course_id';
        $params[':course_id'] = $courseId;
    }
    if ($campusId !== null) {
        $studentWhereParts[] = 'c.department_id IN (SELECT department_id FROM department WHERE campus_id = :campus_id)';
        $params[':campus_id'] = $campusId;
    }
    if ($programId !== null) {
        $studentWhereParts[] = 'c.department_id = :program_id';
        $params[':program_id'] = $programId;
    }
    if ($yearLevel !== null) {
        $studentWhereParts[] = 'st.year_level = :year_level';
        $params[':year_level'] = $yearLevel;
    }
    if ($schoolYearId !== null) {
        $studentWhereParts[] = 'st.schoolyear_id = :school_year_id';
        $attendanceJoinParts[] = 'a.schoolyear_id = :attendance_school_year_id';
        $params[':school_year_id'] = $schoolYearId;
        $params[':attendance_school_year_id'] = $schoolYearId;
    }
    if ($semesterId !== null) {
        $attendanceJoinParts[] = 'a.semester_id = :semester_id';
        $params[':semester_id'] = $semesterId;
    }
    /*
     * Applied to the JOIN, not the WHERE.
     *
     * This is a LEFT JOIN from student to attendance: in the WHERE clause the
     * period test would discard every student with no row for that periodical,
     * so a student who has not been recorded at P2 yet would vanish from the
     * page instead of showing zero classes. In the JOIN they stay, with nothing
     * summed against them, which is the truthful reading.
     */
    [$periodJoinSql, $periodParams] = api_period_filter_sql('a.period', $period, ':attendance_period');
    if ($periodJoinSql !== '') {
        $attendanceJoinParts[] = $periodJoinSql;
        $params += $periodParams;
    }
    /*
     * One upload: only the rows it still holds are summed, and only the
     * students it wrote are listed.
     *
     * Both halves are needed. The join alone would keep every other student on
     * the page at zero, which reads as "this sheet marked them absent"; the
     * EXISTS alone would still sum rows other uploads wrote. The client also
     * sets the term filters to the upload's term, so the two never disagree.
     */
    if ($uploadId !== null) {
        $attendanceJoinParts[] = 'a.upload_id = :upload_id';
        $studentWhereParts[] = 'EXISTS (SELECT 1 FROM attendance au WHERE au.student_id = st.student_id AND au.upload_id = :upload_id_listed)';
        $params[':upload_id'] = $uploadId;
        $params[':upload_id_listed'] = $uploadId;
    }
    // Attendance is now a per-student, per-term summary (uploaded totals); there is
    // no daily `date` column, so date_from/date_to filters no longer apply. When a
    // sheet was uploaded is what upload_id above filters by.

    $authUser = api_get_session_user();
    api_apply_student_type_scope($studentWhereParts, $params, $authUser, 'st.`star e-profile`', ':student_type_scope');

    /*
     * "Show me only the students we are worried about."
     *
     * On the STUDENT parts rather than the attendance join, and that placement
     * matters here more than on the other two screens. This page LEFT JOINs
     * attendance so a student with nothing recorded still appears with zeroes;
     * putting the filter in the join condition would leave those students on the
     * page unfiltered. The filter is about who is listed, so it belongs where
     * the listing is decided.
     */
    pdo_filter_apply($studentWhereParts, $pdo, $query['pdo'] ?? '', $semesterId, $schoolYearId, 'st.student_id', $period);

    $whereSql = empty($studentWhereParts) ? '' : ('WHERE ' . implode(' AND ', $studentWhereParts));
    $attendanceJoinSql = implode(' AND ', $attendanceJoinParts);

    /*
     * Three layers, each doing one job.
     *
     *   grouped  - one row per student, with the periodical figures and the
     *              whole-semester figures kept apart rather than added up
     *   chosen   - which of those two is this student's total
     *   outer    - the percentages, computed from whichever won
     *
     * The middle layer is the point. A semester runs three periodicals and the
     * total is those three; it is not those three plus the legacy row that was
     * uploaded as a whole-semester figure before periodicals existed. Adding
     * both counts the same semester twice - a student with 52 recorded classes
     * and P1/P2/P3 of 20 each came out at 112, which is not a number that
     * happened.
     *
     * So: periodicals if there are any, and the whole-semester row only for a
     * student who has none. That is the same precedence grades.php applies in
     * its ROW_NUMBER() rollup, and the two modules have to agree - a student
     * cannot be on P3 in one and on the old term figure in the other.
     */
    $baseSql = "
        SELECT
            chosen.*,
            CASE
                WHEN chosen.total_classes_conducted = 0 THEN 0
                ELSE ROUND((chosen.present / chosen.total_classes_conducted) * 100, 2)
            END AS present_percentage,
            CASE
                WHEN chosen.total_classes_conducted = 0 THEN 0
                ELSE ROUND((chosen.absent / chosen.total_classes_conducted) * 100, 2)
            END AS absent_percentage
        FROM (
            SELECT
                grouped.*,
                CASE WHEN grouped.periodical_records > 0 THEN grouped.periodical_classes ELSE grouped.semester_classes END AS total_classes_conducted,
                CASE WHEN grouped.periodical_records > 0 THEN grouped.periodical_present ELSE grouped.semester_present END AS present,
                CASE WHEN grouped.periodical_records > 0 THEN grouped.periodical_absent  ELSE grouped.semester_absent  END AS absent
            FROM (
                SELECT
                    st.student_id AS student_record_id,
                    COALESCE(NULLIF(TRIM(st.student_number), ''), CAST(st.student_id AS CHAR)) AS student_id,
                    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', st.first_name, st.middle_name, st.last_name)), ''), st.student_number, CAST(st.student_id AS CHAR)) AS student_name,
                    st.section,
                    st.course_id,
                    c.course_code,
                    c.course_name,
                    c.department_id AS program_id,
                    d.department_name AS program_name,
                    /*
                     * The two candidate totals, kept apart so the layer above
                     * can pick. `periodical_records` is what it picks on: a
                     * student with even one periodical row is being tracked by
                     * periodical, and their old whole-semester row is history.
                     */
                    COUNT(CASE WHEN a.period IS NOT NULL THEN 1 END) AS periodical_records,
                    COALESCE(SUM(CASE WHEN a.period IS NOT NULL THEN a.total_classes_conducted END), 0) AS periodical_classes,
                    COALESCE(SUM(CASE WHEN a.period IS NOT NULL THEN a.present END), 0) AS periodical_present,
                    COALESCE(SUM(CASE WHEN a.period IS NOT NULL THEN a.absent END), 0) AS periodical_absent,
                    COALESCE(SUM(CASE WHEN a.period IS NULL THEN a.total_classes_conducted END), 0) AS semester_classes,
                    COALESCE(SUM(CASE WHEN a.period IS NULL THEN a.present END), 0) AS semester_present,
                    COALESCE(SUM(CASE WHEN a.period IS NULL THEN a.absent END), 0) AS semester_absent,
                    /*
                     * And each periodical on its own, for the P1/P2/P3 columns.
                     *
                     * Deliberately not affected by which periodical the viewer
                     * filtered to - the filter narrows the join, so with P2
                     * selected the P1 and P3 columns come back empty. That is
                     * why the screen shows the breakdown on the Total view
                     * only; see the note on the columns in AttendancePage.jsx.
                     */
                COALESCE(SUM(CASE WHEN a.period = 1 THEN a.total_classes_conducted END), 0) AS p1_classes,
                COALESCE(SUM(CASE WHEN a.period = 1 THEN a.present END), 0) AS p1_present,
                COALESCE(SUM(CASE WHEN a.period = 1 THEN a.absent END), 0) AS p1_absent,
                CASE WHEN COALESCE(SUM(CASE WHEN a.period = 1 THEN a.total_classes_conducted END), 0) = 0 THEN NULL
                     ELSE ROUND((SUM(CASE WHEN a.period = 1 THEN a.present END) / SUM(CASE WHEN a.period = 1 THEN a.total_classes_conducted END)) * 100, 2) END AS p1_rate,
                COALESCE(SUM(CASE WHEN a.period = 2 THEN a.total_classes_conducted END), 0) AS p2_classes,
                COALESCE(SUM(CASE WHEN a.period = 2 THEN a.present END), 0) AS p2_present,
                COALESCE(SUM(CASE WHEN a.period = 2 THEN a.absent END), 0) AS p2_absent,
                CASE WHEN COALESCE(SUM(CASE WHEN a.period = 2 THEN a.total_classes_conducted END), 0) = 0 THEN NULL
                     ELSE ROUND((SUM(CASE WHEN a.period = 2 THEN a.present END) / SUM(CASE WHEN a.period = 2 THEN a.total_classes_conducted END)) * 100, 2) END AS p2_rate,
                COALESCE(SUM(CASE WHEN a.period = 3 THEN a.total_classes_conducted END), 0) AS p3_classes,
                COALESCE(SUM(CASE WHEN a.period = 3 THEN a.present END), 0) AS p3_present,
                COALESCE(SUM(CASE WHEN a.period = 3 THEN a.absent END), 0) AS p3_absent,
                CASE WHEN COALESCE(SUM(CASE WHEN a.period = 3 THEN a.total_classes_conducted END), 0) = 0 THEN NULL
                     ELSE ROUND((SUM(CASE WHEN a.period = 3 THEN a.present END) / SUM(CASE WHEN a.period = 3 THEN a.total_classes_conducted END)) * 100, 2) END AS p3_rate,
                    0 AS breakdown_end
                FROM student st
                LEFT JOIN course c ON c.course_id = st.course_id
                LEFT JOIN department d ON d.department_id = c.department_id
                LEFT JOIN attendance a ON $attendanceJoinSql
                $whereSql
                GROUP BY
                    st.student_id,
                    st.student_number,
                    st.first_name,
                    st.middle_name,
                    st.last_name,
                    st.section,
                    st.course_id,
                    c.course_code,
                    c.course_name,
                    c.department_id,
                    d.department_name
            ) grouped
        ) chosen
    ";

    return [$baseSql, $params];
}

/**
 * The uploads the Upload filter offers, newest first.
 *
 * Only uploads that still hold rows: a later sheet for the same students and
 * term takes their rows over, and an upload left with none would filter the
 * page to nothing. `records` is what it holds now, `rows_written` what it wrote
 * when it ran; the screen says so when they differ.
 *
 * Counted across the college, like the periodical counts, since it describes
 * the upload rather than the viewer's slice of it. The rows the table then
 * lists are still scoped by department and cohort.
 *
 * Empty until migrations/2026_09_25_attendance_upload.sql has run, rather than
 * a 500 on a page that works without it.
 */
function attendance_upload_options(PDO $pdo, int $limit = 100): array {
    if (!api_table_exists($pdo, 'attendance_upload') || !api_column_exists($pdo, 'attendance', 'upload_id')) {
        return [];
    }

    $stmt = $pdo->prepare(
        'SELECT u.upload_id, u.uploaded_at, u.uploader_label, u.file_name,
                u.semester_id, u.schoolyear_id, u.period, u.rows_written,
                s.semester_name, y.schoolyear_name, held.records
           FROM attendance_upload u
           JOIN (SELECT upload_id, COUNT(*) AS records
                   FROM attendance
                  WHERE upload_id IS NOT NULL
                  GROUP BY upload_id) held ON held.upload_id = u.upload_id
           LEFT JOIN semester s ON s.semester_id = u.semester_id
           LEFT JOIN school_year y ON y.school_year_id = u.schoolyear_id
          ORDER BY u.uploaded_at DESC, u.upload_id DESC
          LIMIT :limit'
    );
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();

    return array_map(static function (array $row): array {
        return [
            'upload_id' => (int)$row['upload_id'],
            'uploaded_at' => (string)$row['uploaded_at'],
            'uploaded_by' => $row['uploader_label'] !== null ? (string)$row['uploader_label'] : null,
            'file_name' => $row['file_name'] !== null ? (string)$row['file_name'] : null,
            'semester_id' => (int)$row['semester_id'],
            'semester_name' => $row['semester_name'] !== null ? (string)$row['semester_name'] : null,
            'school_year_id' => (int)$row['schoolyear_id'],
            'schoolyear_name' => $row['schoolyear_name'] !== null ? (string)$row['schoolyear_name'] : null,
            'period' => $row['period'] === null ? null : (int)$row['period'],
            'rows_written' => (int)$row['rows_written'],
            'records' => (int)$row['records'],
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
}

function attendance_bind_params(PDOStatement $stmt, array $params): void {
    foreach ($params as $key => $value) {
        if (is_int($value)) {
            $stmt->bindValue($key, $value, PDO::PARAM_INT);
        } else {
            $stmt->bindValue($key, $value);
        }
    }
}

function attendance_fetch_rows(PDO $pdo, string $baseSql, array $params, string $sort, string $direction, ?int $limit = null, ?int $offset = null): array {
    $sortMap = [
        'student_id' => 'student_id',
        'student_name' => 'student_name',
        'total_classes_conducted' => 'total_classes_conducted',
        'present' => 'present',
        'absent' => 'absent',
        'present_percentage' => 'present_percentage',
        'absent_percentage' => 'absent_percentage',
        'p1_rate' => 'p1_rate',
        'p2_rate' => 'p2_rate',
        'p3_rate' => 'p3_rate',
        'course' => 'course_name',
        'section' => 'section',
    ];
    $sortColumn = $sortMap[$sort] ?? 'student_id';
    $orderDirection = strtoupper($direction) === 'DESC' ? 'DESC' : 'ASC';

    /*
     * The primary key breaks every tie, so a page is a page.
     *
     * Without it the order is only as determined as the chosen column, and
     * these columns tie constantly - every student on 100% attendance sorts
     * equal, and with no attendance recorded at all the entire cohort ties at
     * 0.00. MariaDB is then free to return any twenty of the tied rows.
     *
     * Observed 2026-09-17: sorting by present_percentage across 2,776 all-zero
     * rows returned a *different* twenty students after an unrelated query was
     * removed from the same request. Nothing about the data or the filter
     * changed - only the plan - which is enough to say the order was never the
     * query's to promise.
     *
     * Paging through all fourteen pages did NOT produce a duplicate or a
     * missed student in testing, either before or after this line, so that is
     * a hazard rather than an observed fault. The point is that it was left to
     * the optimiser to get right.
     *
     * student_record_id is the student table's primary key, so it is unique and
     * never null - it settles the order without changing it.
     */
    $sql = "SELECT * FROM ($baseSql) attendance_summary ORDER BY $sortColumn $orderDirection, student_record_id ASC";
    if ($limit !== null && $offset !== null) {
        $sql .= ' LIMIT :limit OFFSET :offset';
    }

    $stmt = $pdo->prepare($sql);
    attendance_bind_params($stmt, $params);
    if ($limit !== null && $offset !== null) {
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    }
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

try {
    $db = new Database();
    $pdo = $db->connect();

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        api_out(405, ['message' => 'Method not allowed']);
    }

    [$baseSql, $params] = attendance_build_query($pdo, $_GET);

    $format = strtolower(attendance_trim_param($_GET, 'format'));
    $sort = strtolower(attendance_trim_param($_GET, 'sort'));
    $direction = strtolower(attendance_trim_param($_GET, 'direction'));

    if (in_array($format, ['csv', 'excel', 'xls', 'pdf'], true)) {
        $rows = attendance_fetch_rows($pdo, $baseSql, $params, $sort, $direction, null, null);
        if ($format === 'csv') attendance_send_csv($rows);
        if ($format === 'pdf') attendance_send_pdf($rows);
        attendance_send_excel($rows);
    }

    $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
    $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 20;
    $offset = ($page - 1) * $limit;

    /*
     * The stats query counts the rows, so nothing else needs to.
     *
     * There used to be a COUNT(*) here as well, over the same $baseSql with the
     * same parameters - the identical question, asked twice. $baseSql is four
     * nested derived tables over every student in scope, and MariaDB
     * materialises the lot each time it is named: one page of twenty students
     * ran it three times and examined ~50,000 rows to do it.
     *
     * `total_students` below is that COUNT(*), so the pagination total is read
     * from it instead. Verified equal across six filter combinations, including
     * the ones that change the number.
     */
    $statsSql = "
        SELECT
            COUNT(*) AS total_students,
            COALESCE(SUM(total_classes_conducted), 0) AS total_classes_conducted,
            CASE
                WHEN COALESCE(SUM(total_classes_conducted), 0) = 0 THEN 0
                ELSE ROUND((COALESCE(SUM(present), 0) / SUM(total_classes_conducted)) * 100, 2)
            END AS average_attendance_rate,
            CASE
                WHEN COALESCE(SUM(total_classes_conducted), 0) = 0 THEN 0
                ELSE ROUND((COALESCE(SUM(absent), 0) / SUM(total_classes_conducted)) * 100, 2)
            END AS average_absence_rate
        FROM ($baseSql) attendance_stats
    ";
    $statsStmt = $pdo->prepare($statsSql);
    attendance_bind_params($statsStmt, $params);
    $statsStmt->execute();
    $stats = $statsStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $total = (int)($stats['total_students'] ?? 0);

    $rows = attendance_fetch_rows($pdo, $baseSql, $params, $sort, $direction, $limit, $offset);

    /*
     * How many rows each periodical holds, so the filter can say "P2 (411)".
     *
     * Counted straight off the attendance table rather than through the scoped
     * query above: this only reports which periodicals exist to choose from, and
     * it must not vary with the period already selected or the option the viewer
     * is standing on would look empty.
     */
    $breakdownStmt = $pdo->query('SELECT period, COUNT(*) AS records FROM attendance GROUP BY period ORDER BY (period IS NULL), period');
    $periodBreakdown = [];
    foreach ($breakdownStmt->fetchAll(PDO::FETCH_ASSOC) as $bucket) {
        $periodBreakdown[] = [
            'period' => $bucket['period'] === null ? null : (int)$bucket['period'],
            'label' => api_period_label($bucket['period']),
            'records' => (int)$bucket['records'],
        ];
    }

    api_out(200, [
        'data' => $rows,
        'stats' => [
            'total_students' => (int)($stats['total_students'] ?? 0),
            'total_classes_conducted' => (int)($stats['total_classes_conducted'] ?? 0),
            'average_attendance_rate' => (float)($stats['average_attendance_rate'] ?? 0),
            'average_absence_rate' => (float)($stats['average_absence_rate'] ?? 0),
        ],
        'periods' => $periodBreakdown,
        'uploads' => attendance_upload_options($pdo),
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'attendance_summary']);
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}

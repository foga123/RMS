/**
 * Spreadsheet import and export.
 *
 * Merged from the former csvImport.js / excelExport.js. They were split by
 * direction, but both sit on the same SpreadsheetML (Excel 2003 XML) format —
 * one parses it, the other writes it — so a change to the format touched both
 * files. Keeping them together makes that coupling visible.
 *
 * .xlsx is deliberately unsupported: it is a zip container, and the PHP side
 * has no `zip` extension, so the portal standardises on CSV and XML .xls.
 */

/* ------------------------------------------------------------------ import */

export function normalizeCsvToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mapRowsToObjects(rows) {
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) => normalizeCsvToken(header));

  return rows
    .slice(1)
    .map((cells, rowIndex) => {
      const values = {};
      headers.forEach((header, cellIndex) => {
        if (!header) return;
        values[header] = String(cells[cellIndex] ?? "").trim();
      });
      return {
        // +2: skip the header row and switch to 1-based numbering, so the
        // number matches what the user sees in their spreadsheet app.
        lineNumber: rowIndex + 2,
        values,
      };
    })
    .filter(({ values }) => Object.values(values).some((value) => String(value || "").trim() !== ""));
}

export function parseCsvRows(text) {
  const rows = [];
  let currentRow = [];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentValue += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = "";
      continue;
    }

    currentValue += char;
  }

  if (currentValue !== "" || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  if (rows.length === 0) return [];
  return mapRowsToObjects(rows);
}

export function parseExcelXmlRows(text) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(String(text || ""), "application/xml");
  const parserError = xml.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error("Invalid XML .xls file. Save the spreadsheet as CSV or XML .xls first.");
  }

  const rowNodes = Array.from(xml.getElementsByTagNameNS("*", "Row"));
  if (rowNodes.length === 0) {
    return [];
  }

  const rows = rowNodes.map((rowNode) => {
    const cellNodes = Array.from(rowNode.children).filter((node) => node.localName === "Cell");
    const cells = [];
    let index = 0;

    cellNodes.forEach((cellNode) => {
      // ss:Index marks a gap where empty cells were skipped by the writer.
      const explicitIndex =
        Number(
          cellNode.getAttribute("ss:Index") ||
            cellNode.getAttribute("Index") ||
            cellNode.getAttributeNS("urn:schemas-microsoft-com:office:spreadsheet", "Index")
        ) || null;

      if (explicitIndex && explicitIndex > 0) {
        index = explicitIndex - 1;
      }

      const dataNode = Array.from(cellNode.children).find((node) => node.localName === "Data");
      cells[index] = String(dataNode?.textContent ?? "").trim();
      index += 1;
    });

    return cells;
  });

  return mapRowsToObjects(rows);
}

/** Dispatch on filename, falling back to sniffing the content. */
export function parseSpreadsheetRows(text, fileName = "") {
  const normalizedFileName = String(fileName || "").trim().toLowerCase();
  const trimmedText = String(text || "").trimStart();

  if (normalizedFileName.endsWith(".xlsx")) {
    throw new Error("XLSX files are not supported yet. Save the spreadsheet as CSV or XML .xls first.");
  }

  if (
    normalizedFileName.endsWith(".xls") ||
    normalizedFileName.endsWith(".xml") ||
    trimmedText.startsWith("<?xml") ||
    trimmedText.includes("<Workbook")
  ) {
    return parseExcelXmlRows(text);
  }

  return parseCsvRows(text);
}

/* ------------------------------------------------------------------ export */

function escapeExcelXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getCellTextLength(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .reduce((maxLength, line) => Math.max(maxLength, line.length), 0);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Size each column to its widest cell, within sane bounds.
 *
 * A column may override the bounds with its own `width` (in characters), which
 * is what the survey matrix uses: a question column holds a whole sentence as
 * its header, so sizing it to the text would produce a column too wide to read
 * across. Those columns pin a width and let WrapText handle the overflow, while
 * Student No. stays narrow because nothing in it is ever long.
 *
 * Every column also carries ss:AutoFitWidth="1", so the width computed here is
 * a starting point Excel is free to improve on rather than a cap it must obey.
 * With "0" the width was final: a workbook opened at a different zoom, or with
 * Calibri substituted for a font the machine does not have, kept columns that
 * no longer matched their contents and showed ##### down a whole column. The
 * measurement still happens here because a column Excel has not laid out yet
 * has no width at all — a file opened by anything other than Excel, LibreOffice
 * or a preview pane included, gets the computed one.
 *
 * A pinned `column.width` is excluded from the refit for the reason above: the
 * matrix pins those widths precisely so Excel will not size a whole sentence
 * onto one line.
 */
function measureColumns(columns, rows, { minChars = 10, maxChars = 45, paddingChars = 2 } = {}) {
  return columns.map((column) => {
    const longestValueLength = rows.reduce((maxLength, row) => {
      return Math.max(maxLength, getCellTextLength(row?.[column.key]));
    }, getCellTextLength(column.label));

    const pinned = Number.isFinite(column.width);
    const widthInChars = pinned
      ? column.width
      : clamp(longestValueLength + paddingChars, minChars, maxChars);

    return {
      column,
      pinned,
      widthInChars,
      /*
       * The widest cell is wider than the column we are asking for — either
       * because it hit `maxChars` or because the column pinned a width.
       *
       * This is the flag that matters: a column that overflows and does not
       * wrap does not show the overflow anywhere. Excel only spills text into
       * the cell to its right when that neighbour is empty, and in a table
       * export it never is, so the text is simply gone from the page. A home
       * address runs past 90 characters and lost about half of itself that
       * way — visibly a full cell, with no hint anything was missing.
       */
      overflows: longestValueLength + paddingChars > widthInChars,
    };
  });
}

function columnXmlFor(measured) {
  return measured
    .map(({ pinned, widthInChars }) => {
      const widthInPoints = widthInChars * 6.5 + 8;
      return `<Column ss:AutoFitWidth="${pinned ? 0 : 1}" ss:Width="${widthInPoints.toFixed(2)}"/>`;
    })
    .join("");
}

function buildColumnXml(columns, rows, options = {}) {
  return columnXmlFor(measureColumns(columns, rows, options));
}

/**
 * Header fill. #047857 measures 5.48:1 against white text, so the label clears
 * AA at normal weight — a lighter brand green would not: #059669 is 3.77:1,
 * which only passes for large text and headers are not large.
 */
const HEADER_FILL = "#047857";
const HEADER_RULE = "#065F46";
const EXAMPLE_TEXT = "#64748B";
/** Light enough to separate cells without drawing a grid that competes with the data. */
const CELL_RULE = "#CBD5E1";

/**
 * Styles, a frozen header row, and the column widths computed above.
 *
 * SpreadsheetML rather than .xlsx for the reason at the top of this file: xlsx
 * is a zip container and the PHP side has no zip extension, so the portal
 * standardises on a format both ends can write and read as plain text. It
 * still carries fills, fonts and frozen panes, which is everything a header
 * row needs.
 */
const WORKBOOK_STYLES = `
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Bottom"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#0F172A"/>
  </Style>
  <Style ss:ID="hdr">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="${HEADER_FILL}" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center" ss:Horizontal="Left"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${HEADER_RULE}"/>
   </Borders>
  </Style>
  <Style ss:ID="ex">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Italic="1" ss:Color="${EXAMPLE_TEXT}"/>
  </Style>
  <Style ss:ID="hdrw">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="${HEADER_FILL}" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center" ss:Horizontal="Left" ss:WrapText="1"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${HEADER_RULE}"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${HEADER_RULE}"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${HEADER_RULE}"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${HEADER_RULE}"/>
   </Borders>
  </Style>
  <Style ss:ID="wrap">
   <Alignment ss:Vertical="Top" ss:Horizontal="Left" ss:WrapText="1"/>
  </Style>
  <Style ss:ID="cell">
   <Alignment ss:Vertical="Top" ss:Horizontal="Left" ss:WrapText="1"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
   </Borders>
  </Style>
  <Style ss:ID="cellk">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#0F172A" ss:Bold="1"/>
   <Alignment ss:Vertical="Top" ss:Horizontal="Left"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="${CELL_RULE}"/>
   </Borders>
  </Style>
 </Styles>`;

/** Keeps the header visible while scrolling a long export. */
const FROZEN_HEADER = `
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>1</SplitHorizontal>
   <TopRowBottomPane>1</TopRowBottomPane>
   <ActivePane>2</ActivePane>
  </WorksheetOptions>`;

/**
 * Excel refuses a sheet name over 31 characters, and silently rejects the five
 * characters below — the whole workbook fails to open rather than the one
 * sheet, so this is not cosmetic.
 */
export function safeSheetName(name, fallback = "Sheet") {
  const cleaned = String(name || "").replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || fallback).slice(0, 31);
}

/**
 * A filter dropdown on every header cell.
 *
 * Excel wants the range in R1C1 notation and counts the header row itself, so a
 * sheet with 3 data rows filters R1C1:R4Cn. Declared after WorksheetOptions —
 * SpreadsheetML is order-sensitive here, and Excel rejects the whole workbook
 * rather than the one element when the order is wrong.
 */
function autoFilterXml(columnCount, rowCount) {
  if (columnCount < 1 || rowCount < 1) return "";
  return `
  <AutoFilter x:Range="R1C1:R${rowCount + 1}C${columnCount}" xmlns="urn:schemas-microsoft-com:office:excel"/>`;
}

function worksheetXml(sheetName, columnXml, bodyXml, filterXml = "") {
  return ` <Worksheet ss:Name="${escapeExcelXml(safeSheetName(sheetName))}">
  <Table>
   ${columnXml}
   ${bodyXml}
  </Table>${FROZEN_HEADER}${filterXml}
 </Worksheet>`;
}

function buildWorkbookXml(sheetsXml) {
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${WORKBOOK_STYLES}
${sheetsXml}
</Workbook>`;
}

function headerRowXml(labels, { styleId = "hdr", height = 19 } = {}) {
  const cells = labels
    .map((label) => `<Cell ss:StyleID="${styleId}"><Data ss:Type="String">${escapeExcelXml(label)}</Data></Cell>`)
    .join("");
  // A wrapping header must be free to grow, so the matrix path passes no fixed
  // height — pinning 19pt would clip a two-line question to its first line.
  const heightAttr = height ? ` ss:Height="${height}"` : "";
  return `<Row ss:AutoFitHeight="1"${heightAttr}>${cells}</Row>`;
}

function downloadWorkbook(filename, workbook) {
  const blob = new Blob([workbook], {
    type: "application/vnd.ms-excel;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * `options.matrix` switches on the presentation a wide response grid needs:
 * wrapped and bordered cells, a wrapped header free to grow to two lines, and a
 * filter row. It is opt-in rather than the default because the attendance,
 * grades and finance exports are narrow tables of short values, where borders on
 * every cell are noise and wrapping never triggers — they keep the plain look
 * they have always had.
 *
 * `column.emphasis` marks the identity columns (student number, name) so they
 * stay on one line and read as the row's label rather than as another answer.
 */
function sheetToXml({ name, columns, rows, options = {} }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const { matrix = false, ...widthOptions } = options;
  const measured = measureColumns(columns, safeRows, widthOptions);
  const columnXml = columnXmlFor(measured);

  /*
   * A plain table keeps its borderless look, so only the columns that need
   * wrapping get a style at all.
   *
   * Wrapping every column instead would have been one line shorter and wrong:
   * `ss:AutoFitHeight="1"` sizes a row to its tallest cell, so a single wrapped
   * Remarks cell already makes that row two lines high. Turning wrap on for the
   * short columns too would not change any row height, but it would left-align
   * and top-align every number in the file, which is not what a balance column
   * should look like.
   */
  const bodyStyleFor = (column, index) => {
    if (matrix) return ` ss:StyleID="${column.emphasis ? "cellk" : "cell"}"`;
    return measured[index]?.overflows ? ' ss:StyleID="wrap"' : "";
  };

  const rowsXml = safeRows
    .map((row) => {
      const cells = columns
        .map(
          (column, index) =>
            `<Cell${bodyStyleFor(column, index)}><Data ss:Type="String">${escapeExcelXml(row?.[column.key])}</Data></Cell>`
        )
        .join("");

      return `<Row ss:AutoFitHeight="1">${cells}</Row>`;
    })
    .join("");

  const header = headerRowXml(
    columns.map((column) => column.label),
    matrix ? { styleId: "hdrw", height: 0 } : {}
  );

  return worksheetXml(
    name,
    columnXml,
    header + rowsXml,
    matrix ? autoFilterXml(columns.length, safeRows.length) : ""
  );
}

export function downloadExcelFile(filename, sheetName, columns, rows, options = {}) {
  downloadWorkbook(filename, buildWorkbookXml(sheetToXml({ name: sheetName, columns, rows, options })));
}

/* ------------------------------------------------------------- CSV export */

/**
 * One CSV cell.
 *
 * Quoted whenever it holds a comma, a quote or a newline, with inner quotes
 * doubled — the same rules parseCsvRows() above reads, so a file this writes
 * can be handed straight back to the importer.
 */
function csvCell(value) {
  const text = String(value ?? "");

  /*
   * A cell starting with = + - or @ is a FORMULA to Excel, Sheets and Numbers,
   * not text — so a stored value like `=cmd|' /C calc'!A1` runs when the
   * exported file is opened, on the reader's machine, with no warning that the
   * spreadsheet came from anywhere but their own system. It is the oldest
   * export vulnerability there is and quoting alone does not stop it: the
   * quotes are stripped by the parser before the formula is evaluated.
   *
   * A leading apostrophe is the documented way to force text. It is consumed by
   * the spreadsheet on open, so the cell still reads as the original value.
   *
   * The importer is unaffected: nothing here writes a leading apostrophe into a
   * value that did not need one, and parseCsvRows() never sees these files —
   * they go to a person, not back into the system.
   */
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * The same table as downloadExcelFile, as CSV.
 *
 * `columns` is the same `{ key, label }` array, so a page describes its table
 * once and offers both formats from it.
 *
 * The file opens with a UTF-8 BOM. Excel on Windows reads a BOM-less CSV in the
 * system codepage, which turns "Peña" into "PeÃ±a" — and a student list here is
 * full of names with an enye in them. Everything else skips a BOM silently.
 *
 * CRLF line endings for the same audience: Excel accepts either, but Notepad
 * still renders a bare LF as one long line.
 */
export function downloadCsvFile(filename, columns, rows) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];

  const lines = [
    safeColumns.map((column) => csvCell(column.label)).join(","),
    ...safeRows.map((row) => safeColumns.map((column) => csvCell(row?.[column.key])).join(",")),
  ];

  const blob = new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * One workbook, several worksheets.
 *
 * The survey matrix needs this because a question column only means anything
 * within its own survey: pivoting every survey into one grid would put every
 * question in the database across the top and leave each student's row blank
 * except for the handful belonging to the survey they actually answered. A sheet
 * per survey keeps each grid dense and readable.
 *
 * Sheet names are deduplicated because Excel refuses a workbook with two sheets
 * of the same name, and two surveys really can share a title — "Student
 * Enrollment Survey" and "Student Enrollment Survey 2" both truncate to the same
 * 31 characters.
 */
export function buildExcelWorkbookXml(sheets) {
  const used = new Set();
  const uniqueName = (name, index) => {
    const base = safeSheetName(name, `Sheet ${index + 1}`);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const tag = ` (${suffix})`;
      const candidate = `${base.slice(0, 31 - tag.length)}${tag}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    return base;
  };

  const xml = (Array.isArray(sheets) ? sheets : [])
    .map((sheet, index) => sheetToXml({ ...sheet, name: uniqueName(sheet.name, index) }))
    .join("\n");

  return buildWorkbookXml(xml);
}

/**
 * Split from the download so the writer can be tested without a DOM: everything
 * above is a pure string transform, and only this last step needs a Blob.
 */
export function downloadExcelWorkbook(filename, sheets) {
  downloadWorkbook(filename, buildExcelWorkbookXml(sheets));
}

/**
 * An import template as a formatted worksheet.
 *
 * Same headers the CSV template carries, so the importer accepts either —
 * parseSpreadsheetRows() reads this format back. The example row is italic and
 * gray so it reads as a hint to overwrite rather than as real data someone
 * should leave in place.
 */
export function buildExcelTemplateXml(headers, exampleRow = [], sheetName = "Template") {
  const labels = (Array.isArray(headers) ? headers : []).map((header) => String(header ?? ""));
  const example = Array.isArray(exampleRow) ? exampleRow : [];

  // buildColumnXml sizes against the widest cell, so the example row is fed in
  // as data — a column headed "Section" holding "BSIT-3A-Irregular" must fit
  // the value, not just the label.
  const columns = labels.map((label, index) => ({ key: String(index), label }));
  const widthRows = example.length > 0
    ? [labels.reduce((row, _label, index) => ({ ...row, [String(index)]: example[index] ?? "" }), {})]
    : [];
  const columnXml = buildColumnXml(columns, widthRows);

  const exampleXml = example.length > 0
    ? `<Row ss:AutoFitHeight="1">${labels
        .map((_label, index) => `<Cell ss:StyleID="ex"><Data ss:Type="String">${escapeExcelXml(example[index] ?? "")}</Data></Cell>`)
        .join("")}</Row>`
    : "";

  return buildWorkbookXml(worksheetXml(sheetName, columnXml, headerRowXml(labels) + exampleXml));
}

export function downloadExcelTemplate(filename, headers, exampleRow = [], sheetName = "Template") {
  downloadWorkbook(filename, buildExcelTemplateXml(headers, exampleRow, sheetName));
}

import { localDateIso } from "./localDate";

/**
 * A table as a PDF, written by hand, with no library behind it.
 *
 * tableExport.js used to say PDF was off the menu because "there is no PDF
 * writer in the browser and adding one for a printout of a table is not worth
 * the dependency". The first half was true; the second assumed a dependency was
 * required. attendance-summary.php has been writing PDFs since long before this
 * file existed, in about ninety lines of plain string building, because the
 * parts of the format a table needs are small: a catalogue, a page list, one
 * content stream per page, one of the fourteen fonts every reader ships with,
 * and a cross-reference table of byte offsets. No compression, no embedded
 * fonts, no images. So this is the same trick, moved to the browser and given
 * the two things the PHP version does without.
 *
 * What it does that attendance-summary.php does not:
 *
 *   - Columns are measured and fitted to the page, rather than a hand-tuned
 *     list of character widths. That file carries a comment explaining that it
 *     drops three of its ten columns because seven is what its fixed layout can
 *     hold; here the layout follows the columns instead.
 *   - Helvetica, not Courier, using the real Adobe metrics below. Courier is
 *     what you reach for when you are padding strings to align them, and the
 *     cost is a page that reads like a mainframe dump.
 *
 * ---------------------------------------------------------------------------
 * Everything here is byte-exact on purpose
 *
 * A PDF's cross-reference table is a list of BYTE offsets, so the file is
 * assembled as a string in which every character is a single byte — code point
 * 0x00 to 0xFF — and written out one charCode per byte. Encoding it as UTF-8
 * anywhere along the way shifts every offset after the first non-ASCII
 * character and produces a file readers reject. That is why text goes through
 * toWinAnsi() before it is measured or written, and why downloadPdfFile builds
 * a Uint8Array rather than handing the string to Blob.
 * ---------------------------------------------------------------------------
 */

/* --------------------------------------------------------------- geometry */

/** Landscape Letter. A table is wider than it is tall; so is this. */
const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const TITLE_SIZE = 14;
const SUBTITLE_SIZE = 9;
const FOOTER_SIZE = 7.5;
const ROW_HEIGHT = 13;
const CELL_PADDING = 4;

/** Below this a column shows one letter and an ellipsis, which is not a column. */
const MIN_COLUMN_WIDTH = 30;

/** Where the table starts, under the title and its subtitle. */
const TABLE_TOP = PAGE_HEIGHT - MARGIN - TITLE_SIZE - 26;
/** Where it must stop, above the footer line. */
const TABLE_BOTTOM = MARGIN + 16;

const ROWS_PER_PAGE = Math.max(1, Math.floor((TABLE_TOP - ROW_HEIGHT - TABLE_BOTTOM) / ROW_HEIGHT));

/* ----------------------------------------------------------------- colour */

/**
 * The header green is the one the Excel export already uses, for the same
 * contrast reason recorded there: #047857 is 5.48:1 against white and clears AA
 * at normal weight, where a lighter brand green would not.
 */
const HEADER_FILL = "0.016 0.471 0.341";
const HEADER_TEXT = "1 1 1";
const BODY_TEXT = "0.059 0.090 0.165";
const MUTED_TEXT = "0.392 0.455 0.545";
/** Faint enough to group rows without drawing a grid over the data. */
const STRIPE_FILL = "0.945 0.961 0.976";

/* ----------------------------------------------------------- font metrics */

/**
 * Helvetica and Helvetica-Bold advance widths, in 1/1000 em, for the printable
 * ASCII range — straight from the Adobe Font Metrics for the base fourteen.
 *
 * These are what make column fitting honest. Guessing an average width instead
 * puts "Bachelor of Science in Information Technology" a third of the way over
 * its column with no truncation and no warning, because nothing measures it
 * again before it is drawn.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * Accented letters are composed from a base glyph and carry its width, so a
 * flat 556 (611 bold) is right for most of the upper range and never off by
 * more than a fraction of a point at 8pt. It only decides where to truncate.
 */
const WIDE_FALLBACK = 556;
const WIDE_FALLBACK_BOLD = 611;

const FIRST_MEASURED = 32;
const LAST_MEASURED = 126;

/* -------------------------------------------------------------- encoding */

/**
 * The characters WinAnsi keeps in 0x80-0x9F, where Latin-1 has control codes.
 *
 * The em dash earns its place on its own: the Students table renders a blank
 * field as one, so a student list exported from this app is full of U+2014.
 * Dropped rather than mapped, it would print as "?" down whole columns.
 */
const WIN_ANSI_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * Text as WinAnsi, one character per byte.
 *
 * Latin-1 passes through untouched, which covers the enye in half the surnames
 * in this database. The handful of typographic characters above are remapped,
 * newlines and tabs become spaces so a stored multi-line remark stays on its
 * row, and anything genuinely outside the encoding becomes "?" — visible, and
 * better than a byte a reader will refuse the whole file over.
 */
export function toWinAnsi(value) {
  const text = String(value ?? "").replace(/\s+/g, " ");
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) {
      out += text[index];
    } else if (code >= 0xa0 && code <= 0xff) {
      out += text[index];
    } else if (WIN_ANSI_HIGH[code] !== undefined) {
      out += String.fromCharCode(WIN_ANSI_HIGH[code]);
    } else {
      out += "?";
    }
  }
  return out;
}

/** Width of already-encoded text, in 1/1000 em. */
function measureEm(text, bold = false) {
  const widths = bold ? HELVETICA_BOLD : HELVETICA;
  const fallback = bold ? WIDE_FALLBACK_BOLD : WIDE_FALLBACK;
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    total += code >= FIRST_MEASURED && code <= LAST_MEASURED ? widths[code - FIRST_MEASURED] : fallback;
  }
  return total;
}

/** Width in points at a given size. */
function widthAt(em, size) {
  return (em * size) / 1000;
}

/**
 * Text cut to fit, with an ellipsis when anything was lost.
 *
 * The ellipsis is what separates a truncated value from a short one. Excel
 * spills a long value into the next cell or shows #####; a PDF just paints the
 * overflow on top of the neighbouring column, so the cut has to happen here and
 * has to be visible.
 */
function truncateToWidth(text, size, limit, bold = false) {
  if (widthAt(measureEm(text, bold), size) <= limit) return text;

  const ellipsis = "...";
  const ellipsisWidth = widthAt(measureEm(ellipsis, bold), size);
  let width = 0;
  let cut = "";

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const charWidth = widthAt(
      code >= FIRST_MEASURED && code <= LAST_MEASURED
        ? (bold ? HELVETICA_BOLD : HELVETICA)[code - FIRST_MEASURED]
        : bold ? WIDE_FALLBACK_BOLD : WIDE_FALLBACK,
      size
    );
    if (width + charWidth + ellipsisWidth > limit) break;
    width += charWidth;
    cut += text[index];
  }

  return cut === "" ? "" : `${cut.trimEnd()}${ellipsis}`;
}

/* --------------------------------------------------------------- layout */

/**
 * Body size, chosen from how much there is to fit.
 *
 * A narrow table stays at 8pt. A wide one steps down rather than truncating
 * every column at once: dropping two points buys back a quarter of the width,
 * which is the difference between a readable name column and eight characters
 * and an ellipsis. It stops at 6pt because below that a printout is not one.
 */
function fitFontSize(naturalEmTotal) {
  const at8 = widthAt(naturalEmTotal, 8) + 0;
  if (at8 <= CONTENT_WIDTH * 1.5) return 8;
  if (at8 <= CONTENT_WIDTH * 2.2) return 7;
  return 6;
}

/**
 * Column widths that add up to exactly the printable width.
 *
 * Proportional to what each column actually holds, so Student No. stays narrow
 * and Department gets the room, then floored at MIN_COLUMN_WIDTH so a column of
 * short values does not collapse to nothing. The floor is skipped outright when
 * there are so many columns that it cannot be honoured — enforcing it then would
 * push the table off the right edge of the page, which is worse than a tight
 * column, and is the failure mode nobody sees until it prints.
 */
export function fitColumnWidths(naturalWidths, available = CONTENT_WIDTH) {
  const count = naturalWidths.length;
  if (count === 0) return [];

  const total = naturalWidths.reduce((sum, width) => sum + width, 0) || 1;
  const widths = naturalWidths.map((width) => (width / total) * available);

  if (count * MIN_COLUMN_WIDTH > available) return widths;

  /*
   * Raise one column to the floor at a time, then re-share what is left among
   * the columns still free — repeating, because giving one column its minimum
   * takes width from the others and can push the next one under in turn.
   *
   * Pinned columns are recorded rather than inferred from their width. Testing
   * `width < MIN` again on the next pass reads a column sitting exactly on the
   * floor as free, scales it down, and the pass after that raises it back: the
   * two fight, and the loop exits wherever it happened to be. It left five
   * columns at 29.998 in a seventeen-column table — harmless in itself, and
   * the same flaw with a different count of columns is a table that no longer
   * adds up to the width of the page.
   */
  const pinned = new Array(count).fill(false);

  for (let pass = 0; pass < count; pass += 1) {
    const under = widths.findIndex((width, index) => !pinned[index] && width < MIN_COLUMN_WIDTH);
    if (under === -1) break;

    pinned[under] = true;
    widths[under] = MIN_COLUMN_WIDTH;

    const reserved = pinned.reduce((sum, isPinned, index) => (isPinned ? sum + widths[index] : sum), 0);
    const freeNatural =
      naturalWidths.reduce((sum, width, index) => (pinned[index] ? sum : sum + width), 0) || 1;
    const remaining = Math.max(available - reserved, 0);

    naturalWidths.forEach((width, index) => {
      if (!pinned[index]) widths[index] = (width / freeNatural) * remaining;
    });
  }

  return widths;
}

/* ------------------------------------------------------ content stream */

function pdfEscape(text) {
  return text.replace(/[\\()]/g, "\\$&");
}

/** Numbers in a PDF are plain decimals — no exponent notation, ever. */
function num(value) {
  return (Math.round(value * 100) / 100).toString();
}

function textAt(font, size, colour, x, y, text) {
  return `BT /${font} ${num(size)} Tf ${colour} rg 1 0 0 1 ${num(x)} ${num(y)} Tm (${pdfEscape(text)}) Tj ET\n`;
}

function fillRect(x, y, width, height, colour) {
  return `${colour} rg ${num(x)} ${num(y)} ${num(width)} ${num(height)} re f\n`;
}

/* ---------------------------------------------------------------- writer */

function cellText(value) {
  return toWinAnsi(value === null || value === undefined ? "" : value);
}

/**
 * The table as a PDF file, returned as a byte-per-character string.
 *
 * `columns` is the same `[{ key, label }]` array the Excel and CSV exports take,
 * so a caller describes its table once and gets all three from it.
 */
export function buildPdfTable({ title, subtitle, columns, rows }) {
  const safeColumns = (Array.isArray(columns) ? columns : []).map((column) => ({
    key: column.key,
    label: toWinAnsi(column.label ?? ""),
  }));
  const safeRows = Array.isArray(rows) ? rows : [];

  // Encoded once, up front. Every row is measured during fitting and read again
  // while drawing, and running the encoder twice over 1,600 rows to get the same
  // answer is work for nothing.
  const encoded = safeRows.map((row) => safeColumns.map((column) => cellText(row?.[column.key])));

  const headerEm = safeColumns.map((column) => measureEm(column.label, true));
  const bodyEm = safeColumns.map((_column, index) =>
    encoded.reduce((max, cells) => Math.max(max, measureEm(cells[index])), 0)
  );

  // Header at 8pt against body at 8pt: the size chosen next scales both, so the
  // ratio between them does not change and this stays the right comparison.
  const naturalEm = safeColumns.map((_column, index) => Math.max(headerEm[index], bodyEm[index]));
  const bodySize = fitFontSize(naturalEm.reduce((sum, em) => sum + em, 0));
  const headerSize = bodySize;

  const natural = naturalEm.map((em) => widthAt(em, bodySize) + CELL_PADDING * 2);
  const widths = fitColumnWidths(natural);

  const offsets = [];
  let x = MARGIN;
  widths.forEach((width) => {
    offsets.push(x);
    x += width;
  });

  const pages = [];
  for (let index = 0; index < encoded.length; index += ROWS_PER_PAGE) {
    pages.push(encoded.slice(index, index + ROWS_PER_PAGE));
  }
  // An empty table still gets a page, so the file says "no records" rather than
  // being a PDF with no pages in it, which readers reject outright.
  if (pages.length === 0) pages.push([]);

  const heading = toWinAnsi(title || "Export");
  const subheading = toWinAnsi(
    subtitle ?? `${safeRows.length.toLocaleString("en-US")} ${safeRows.length === 1 ? "record" : "records"} · exported ${localDateIso()}`
  );

  const streams = pages.map((pageRows, pageIndex) => {
    let content = "";

    content += textAt("F2", TITLE_SIZE, BODY_TEXT, MARGIN, PAGE_HEIGHT - MARGIN - TITLE_SIZE, heading);
    content += textAt("F1", SUBTITLE_SIZE, MUTED_TEXT, MARGIN, PAGE_HEIGHT - MARGIN - TITLE_SIZE - 13, subheading);

    // The header band repeats on every page, and so does the title: a page that
    // gets separated from the rest of the printout still says what it is and
    // what its columns are.
    const headerBottom = TABLE_TOP - ROW_HEIGHT;
    content += fillRect(MARGIN, headerBottom, CONTENT_WIDTH, ROW_HEIGHT, HEADER_FILL);
    safeColumns.forEach((column, index) => {
      const limit = widths[index] - CELL_PADDING * 2;
      const label = truncateToWidth(column.label, headerSize, limit, true);
      if (label === "") return;
      content += textAt("F2", headerSize, HEADER_TEXT, offsets[index] + CELL_PADDING, headerBottom + 4, label);
    });

    pageRows.forEach((cells, rowIndex) => {
      const bottom = headerBottom - ROW_HEIGHT * (rowIndex + 1);
      if (rowIndex % 2 === 1) {
        content += fillRect(MARGIN, bottom, CONTENT_WIDTH, ROW_HEIGHT, STRIPE_FILL);
      }
      cells.forEach((cell, index) => {
        if (cell === "") return;
        const limit = widths[index] - CELL_PADDING * 2;
        const text = truncateToWidth(cell, bodySize, limit);
        if (text === "") return;
        content += textAt("F1", bodySize, BODY_TEXT, offsets[index] + CELL_PADDING, bottom + 4, text);
      });
    });

    if (pageRows.length === 0) {
      content += textAt("F1", SUBTITLE_SIZE, MUTED_TEXT, MARGIN, headerBottom - ROW_HEIGHT, "No records.");
    }

    const footer = `Page ${pageIndex + 1} of ${pages.length}`;
    const footerWidth = widthAt(measureEm(footer), FOOTER_SIZE);
    content += textAt("F1", FOOTER_SIZE, MUTED_TEXT, PAGE_WIDTH - MARGIN - footerWidth, MARGIN, footer);

    return content;
  });

  /*
   * Object numbering, which the cross-reference table depends on being exact.
   *
   * 1 catalogue, 2 page tree, then a page and a content stream per page, and the
   * two fonts last. Written as a flat list where position i holds object i + 1,
   * because that is the only relationship the xref cares about.
   */
  const pageCount = pages.length;
  const firstPageObject = 3;
  const regularFontObject = firstPageObject + pageCount * 2;
  const boldFontObject = regularFontObject + 1;

  const objects = [];
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";

  const kids = [];
  pages.forEach((_pageRows, index) => {
    const pageObject = firstPageObject + index * 2;
    const contentObject = pageObject + 1;
    kids.push(`${pageObject} 0 R`);
    objects[pageObject - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${regularFontObject} 0 R /F2 ${boldFontObject} 0 R >> >> ` +
      `/Contents ${contentObject} 0 R >>`;
    objects[contentObject - 1] =
      `<< /Length ${streams[index].length} >>\nstream\n${streams[index]}endstream`;
  });

  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`;
  // WinAnsiEncoding rather than the default: the base fourteen fall back to
  // StandardEncoding, which has no enye at all.
  objects[regularFontObject - 1] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[boldFontObject - 1] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  let pdf = "%PDF-1.4\n";
  const byteOffsets = [];
  objects.forEach((object, index) => {
    byteOffsets[index] = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startXref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  objects.forEach((_object, index) => {
    pdf += `${String(byteOffsets[index]).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;

  return pdf;
}

/**
 * Split from the writer above so the file can be built and inspected without a
 * DOM — the same split downloadExcelWorkbook keeps, and for the same reason.
 */
export function downloadPdfFile(filename, { title, subtitle, columns, rows }) {
  const pdf = buildPdfTable({ title, subtitle, columns, rows });

  // One byte per character. Handing the string to Blob would encode it as UTF-8
  // and move every offset the xref table just recorded.
  const bytes = new Uint8Array(pdf.length);
  for (let index = 0; index < pdf.length; index += 1) {
    bytes[index] = pdf.charCodeAt(index) & 0xff;
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

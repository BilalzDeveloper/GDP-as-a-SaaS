// The file-parsing boundary. This is the ONLY intake module that touches file
// bytes or a third-party library; mapping and validation stay pure so they
// can be tested exhaustively without fixtures on disk.
import ExcelJS from 'exceljs';
import { parseCsv } from '../../scripts/lib/csv.mjs';
import type { ParsedFile, ParsedRow } from './types';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // see DECISIONS.md D20

export class ParseError extends Error {}

function buildRows(header: string[], dataRows: string[][]): ParsedRow[] {
  return dataRows.map((cells, index) => {
    const record: Record<string, string> = {};
    header.forEach((name, i) => {
      record[name] = (cells[i] ?? '').trim();
    });
    return {
      // +2: one for the header row, one because humans count from 1 — this
      // number is quoted back to a compiler who will look at that line.
      rowNumber: index + 2,
      cells: record,
    };
  });
}

/** De-duplicate and fill blank header names so columns stay addressable. */
function normaliseHeader(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((name, i) => {
    const base = (name ?? '').trim() || `column_${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function parseCsvFile(text: string): ParsedFile {
  const rows = parseCsv(text) as string[][];
  if (rows.length === 0) throw new ParseError('The file is empty.');
  const header = normaliseHeader(rows[0]);
  const body = rows.slice(1).filter((r) => r.some((c) => (c ?? '').trim() !== ''));
  return { header, rows: buildRows(header, body) };
}

/**
 * Read the first worksheet (or a named one) of an xlsx workbook.
 *
 * Cells are converted to text and interpreted later by `parseNumericCell`,
 * deliberately: Excel's own type inference is what turns a code like "01"
 * into the number 1 and a period label into a date, and re-deriving text from
 * the stored value keeps the mapping in charge of interpretation.
 */
export async function parseXlsxFile(
  bytes: Buffer | ArrayBuffer,
  sheetName?: string,
): Promise<ParsedFile> {
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(new Uint8Array(bytes));
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (e) {
    throw new ParseError(
      `The spreadsheet could not be read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const sheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0];
  if (!sheet) {
    throw new ParseError(
      sheetName
        ? `The workbook has no sheet named "${sheetName}".`
        : 'The workbook contains no worksheets.',
    );
  }

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellToText(cell);
    });
    grid.push([...cells].map((c) => c ?? ''));
  });

  if (grid.length === 0) throw new ParseError('The worksheet is empty.');
  const header = normaliseHeader(grid[0]);
  const body = grid.slice(1).filter((r) => r.some((c) => (c ?? '').trim() !== ''));
  return { header, rows: buildRows(header, body), sheetName: sheet.name };
}

function cellToText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    // A period column read as a date is common; ISO keeps it unambiguous and
    // lets the mapping decide what it means.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value && value.result !== undefined) return String(value.result);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('error' in value) return String(value.error);
  }
  return String(value);
}

export type SupportedFormat = 'csv' | 'xlsx';

export function detectFormat(filename: string, contentType?: string): SupportedFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx';
  if (contentType?.includes('spreadsheetml')) return 'xlsx';
  if (contentType?.includes('csv') || contentType?.includes('text/plain')) return 'csv';
  throw new ParseError(
    `Unsupported file type "${filename}". Upload a .csv or .xlsx file. ` +
      `The legacy .xls format is not supported — re-save it as .xlsx.`,
  );
}

export async function parseUpload(
  filename: string,
  bytes: Buffer,
  contentType?: string,
  sheetName?: string,
): Promise<ParsedFile> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ParseError(
      `The file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ` +
        `${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  const format = detectFormat(filename, contentType);
  return format === 'csv'
    ? parseCsvFile(bytes.toString('utf8'))
    : parseXlsxFile(bytes, sheetName);
}

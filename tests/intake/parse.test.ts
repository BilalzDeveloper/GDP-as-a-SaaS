// Parsing real files. The xlsx cases build actual workbooks with exceljs
// rather than mocking, because the failures worth catching are exactly the
// ones a mock would paper over: a code like "01" coerced to the number 1, a
// period label stored as a date, a formula cell.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  parseCsvFile,
  parseUpload,
  parseXlsxFile,
  ParseError,
  MAX_UPLOAD_BYTES,
} from '../../src/intake/parse';

async function workbookBytes(
  rows: (string | number | Date | null)[][],
  sheetName = 'Sheet1',
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('CSV', () => {
  it('reads a header and rows', () => {
    const parsed = parseCsvFile('txn,year,value\nP.1,2023,500\nP.2,2023,200\n');
    expect(parsed.header).toEqual(['txn', 'year', 'value']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].cells).toEqual({ txn: 'P.1', year: '2023', value: '500' });
  });

  it('numbers rows as a human reading the file would', () => {
    // Row 2 is the first data row: the header is row 1.
    const parsed = parseCsvFile('a,b\n1,2\n3,4\n');
    expect(parsed.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it('keeps quoted fields containing commas intact', () => {
    const parsed = parseCsvFile('code,name\n01,"Crop and animal production, hunting"\n');
    expect(parsed.rows[0].cells.name).toBe('Crop and animal production, hunting');
  });

  it('skips wholly blank lines', () => {
    const parsed = parseCsvFile('a,b\n1,2\n\n3,4\n');
    expect(parsed.rows).toHaveLength(2);
  });

  it('names blank header columns so they stay addressable', () => {
    const parsed = parseCsvFile('a,,c\n1,2,3\n');
    expect(parsed.header).toEqual(['a', 'column_2', 'c']);
  });

  it('disambiguates duplicate header names', () => {
    const parsed = parseCsvFile('value,value\n1,2\n');
    expect(parsed.header).toEqual(['value', 'value_2']);
    expect(parsed.rows[0].cells).toEqual({ value: '1', value_2: '2' });
  });

  it('rejects an empty file', () => {
    expect(() => parseCsvFile('')).toThrow(ParseError);
  });
});

describe('XLSX', () => {
  it('reads a simple sheet', async () => {
    const bytes = await workbookBytes([
      ['txn', 'year', 'value'],
      ['P.1', 2023, 500],
    ]);
    const parsed = await parseXlsxFile(bytes);
    expect(parsed.header).toEqual(['txn', 'year', 'value']);
    expect(parsed.rows[0].cells).toEqual({ txn: 'P.1', year: '2023', value: '500' });
  });

  it('preserves a leading-zero code stored as text', async () => {
    // ISIC "01" must not come back as "1" — it would resolve to the wrong
    // classification item, or to none.
    const bytes = await workbookBytes([
      ['isic', 'value'],
      ['01', 500],
    ]);
    const parsed = await parseXlsxFile(bytes);
    expect(parsed.rows[0].cells.isic).toBe('01');
  });

  it('renders a date cell as ISO rather than a serial number', async () => {
    const bytes = await workbookBytes([
      ['period', 'value'],
      [new Date(Date.UTC(2023, 0, 1)), 500],
    ]);
    const parsed = await parseXlsxFile(bytes);
    expect(parsed.rows[0].cells.period).toBe('2023-01-01');
  });

  it('reads the cached result of a formula cell', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['a', 'b']);
    ws.addRow([2, { formula: 'A2*3', result: 6 }]);
    const parsed = await parseXlsxFile(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.rows[0].cells.b).toBe('6');
  });

  it('reads rich text as its plain text', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['label']);
    ws.addRow([{ richText: [{ text: 'Gross ' }, { text: 'output' }] }]);
    const parsed = await parseXlsxFile(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.rows[0].cells.label).toBe('Gross output');
  });

  it('reports the sheet it read', async () => {
    const bytes = await workbookBytes([['a'], ['1']], 'Production');
    const parsed = await parseXlsxFile(bytes);
    expect(parsed.sheetName).toBe('Production');
  });

  it('can be pointed at a named sheet', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('First').addRow(['a']);
    const second = wb.addWorksheet('Second');
    second.addRow(['b']);
    second.addRow(['42']);
    const parsed = await parseXlsxFile(
      Buffer.from(await wb.xlsx.writeBuffer()),
      'Second',
    );
    expect(parsed.header).toEqual(['b']);
  });

  it('names a sheet that does not exist rather than failing obscurely', async () => {
    const bytes = await workbookBytes([['a'], ['1']]);
    await expect(parseXlsxFile(bytes, 'Nope')).rejects.toThrow(/no sheet named "Nope"/);
  });

  it('rejects bytes that are not a workbook', async () => {
    await expect(parseXlsxFile(Buffer.from('not a spreadsheet'))).rejects.toThrow(
      ParseError,
    );
  });
});

describe('format detection', () => {
  it.each([
    ['data.csv', 'csv'],
    ['data.CSV', 'csv'],
    ['extract.tsv', 'csv'],
    ['book.xlsx', 'xlsx'],
    ['book.xlsm', 'xlsx'],
  ])('detects %s', (name, expected) => {
    expect(detectFormat(name)).toBe(expected);
  });

  it('falls back to the content type', () => {
    expect(detectFormat('upload', 'text/csv')).toBe('csv');
    expect(
      detectFormat(
        'upload',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('xlsx');
  });

  it('tells the user what to do about a legacy .xls file', () => {
    expect(() => detectFormat('old.xls')).toThrow(/re-save it as .xlsx/);
  });
});

describe('upload limits', () => {
  it('refuses a file over the size cap', async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    await expect(parseUpload('big.csv', big)).rejects.toThrow(/limit is 10 MB/);
  });

  it('routes csv and xlsx through the right parser', async () => {
    const csv = await parseUpload('a.csv', Buffer.from('x\n1\n'));
    expect(csv.rows[0].cells.x).toBe('1');
    const xlsx = await parseUpload('a.xlsx', await workbookBytes([['x'], ['1']]));
    expect(xlsx.rows[0].cells.x).toBe('1');
  });
});

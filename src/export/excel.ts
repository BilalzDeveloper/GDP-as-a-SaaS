// Excel export. Uses exceljs, already a dependency for reading uploads.
//
// The workbook is laid out for a human reading a release, not for a machine:
// one sheet per price basis, a provenance sheet recording exactly what the
// figures came from, and — when relevant — the non-additivity note beside the
// volume figures rather than in a separate document.
import ExcelJS from 'exceljs';

export interface ExcelRunMeta {
  organisation: string;
  runName: string;
  vintageName: string;
  frozenAt: string | null;
  status: string;
  anchorApproach: string;
  engineVersion: string | null;
  methodConfig: string | null;
  executedAt: string | null;
  publishedAt: string | null;
  embargoUntil: string | null;
  sourceFiles: { filename: string; sha256: string }[];
}

export interface ExcelRow {
  periodLabel: string;
  approach: string;
  measure: string;
  activityCode: string | null;
  activityName: string | null;
  priceBasis: string;
  value: number | null;
}

export async function toExcelWorkbook(
  meta: ExcelRunMeta,
  rows: readonly ExcelRow[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GDP Compilation Platform';
  workbook.created = new Date();

  if (meta.embargoUntil) {
    // Impossible to miss when the file is opened.
    const notice = workbook.addWorksheet('EMBARGOED');
    notice.getCell('A1').value = 'EMBARGOED — NOT FOR RELEASE';
    notice.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFB00000' } };
    notice.getCell('A2').value = `These figures are under embargo until ${meta.embargoUntil}.`;
    notice.getCell('A3').value =
      'Do not circulate outside the organisation before that time.';
    notice.getColumn(1).width = 80;
  }

  const byBasis = new Map<string, ExcelRow[]>();
  for (const row of rows) {
    const list = byBasis.get(row.priceBasis) ?? [];
    list.push(row);
    byBasis.set(row.priceBasis, list);
  }

  const BASIS_SHEET: Record<string, string> = {
    current: 'Current prices',
    chain_linked: 'Chain-linked volumes',
    previous_year: 'Previous-year prices',
  };

  for (const [basis, basisRows] of byBasis) {
    const sheet = workbook.addWorksheet(BASIS_SHEET[basis] ?? basis);
    sheet.columns = [
      { header: 'Period', key: 'period', width: 12 },
      { header: 'Approach', key: 'approach', width: 14 },
      { header: 'Measure', key: 'measure', width: 30 },
      { header: 'Activity code', key: 'code', width: 14 },
      { header: 'Activity', key: 'activity', width: 40 },
      { header: 'Value', key: 'value', width: 18 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of basisRows) {
      sheet.addRow({
        period: row.periodLabel,
        approach: row.approach,
        measure: row.measure,
        code: row.activityCode ?? '',
        activity: row.activityName ?? '',
        // Null stays empty: a missing observation is not a zero.
        value: row.value,
      });
    }
    sheet.getColumn('value').numFmt = '#,##0.000';

    if (basis === 'chain_linked') {
      const note = sheet.addRow([]);
      sheet.addRow([
        'Note: chain-linked volumes are NOT additive. Components do not sum to',
      ]);
      sheet.addRow([
        'their aggregate except in the reference period and the one after it.',
      ]);
      sheet.addRow([
        'Each series carries its own price weights, so their sum has no reason',
      ]);
      sheet.addRow([
        'to equal an aggregate weighted for the whole economy. This is a',
      ]);
      sheet.addRow([
        'property of the measure (SNA 2008 ch.15), not an error in the figures.',
      ]);
      void note;
    }
  }

  // Provenance: what these figures were computed from, and by what.
  const provenance = workbook.addWorksheet('Provenance');
  provenance.columns = [
    { header: 'Field', key: 'field', width: 26 },
    { header: 'Value', key: 'value', width: 70 },
  ];
  provenance.getRow(1).font = { bold: true };
  const entries: [string, string][] = [
    ['Organisation', meta.organisation],
    ['Compilation run', meta.runName],
    ['Input vintage', meta.vintageName],
    ['Vintage frozen at', meta.frozenAt ?? 'not frozen'],
    ['Run status', meta.status],
    ['Balancing anchor', meta.anchorApproach],
    ['Engine version', meta.engineVersion ?? 'not recorded'],
    ['Method configuration', meta.methodConfig ?? 'not recorded'],
    ['Executed at', meta.executedAt ?? 'not executed'],
    ['Published at', meta.publishedAt ?? 'not published'],
    ['Embargo until', meta.embargoUntil ?? 'none'],
    ['Exported at', new Date().toISOString()],
  ];
  for (const [field, value] of entries) provenance.addRow({ field, value });

  if (meta.sourceFiles.length > 0) {
    provenance.addRow({});
    provenance.addRow({ field: 'Source files', value: 'SHA-256' });
    provenance.getRow(provenance.rowCount).font = { bold: true };
    for (const file of meta.sourceFiles) {
      provenance.addRow({ field: file.filename, value: file.sha256 });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

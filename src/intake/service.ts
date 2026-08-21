// Database-facing intake operations. Everything here runs through withRls(),
// so tenant isolation and the audit trail apply exactly as they do elsewhere.
//
// The pure modules (mapping, validate, numbers) own all judgement; this file
// only moves data between them and the database.
import { sql } from 'drizzle-orm';
import { withRls, type RlsClaims, type Tx } from '@/db/rls';
import { resolveRows } from './mapping';
import { validateRows, canCommit } from './validate';
import type {
  MappingDefinition,
  ParsedFile,
  ReferenceContext,
  ValidationResult,
} from './types';

/** Load the reference data the pure modules need, scoped to one organization. */
export async function loadReferenceContext(
  tx: Tx,
  orgId: string,
  mapping: MappingDefinition,
): Promise<ReferenceContext> {
  const txnRows = (await tx.execute(
    sql`select code from transaction_code`,
  )) as unknown as { code: string }[];
  const unitRows = (await tx.execute(
    sql`select code from unit`,
  )) as unknown as { code: string }[];
  const periodRows = (await tx.execute(sql`
    select id, label from reference_period
     where org_id = ${orgId}::uuid and frequency = ${mapping.frequency}::period_frequency
  `)) as unknown as { id: string; label: string }[];

  const versionIds = [
    mapping.activityVersionId,
    mapping.productVersionId,
    mapping.sectorVersionId,
    mapping.purposeVersionId,
  ].filter((v): v is string => !!v);

  const itemIdsByVersion = new Map<string, Map<string, string>>();
  const itemCodesByVersion = new Map<string, Set<string>>();
  for (const versionId of new Set(versionIds)) {
    const items = (await tx.execute(sql`
      select id, code from classification_item where version_id = ${versionId}::uuid
    `)) as unknown as { id: string; code: string }[];
    const byCode = new Map<string, string>();
    for (const item of items) byCode.set(item.code, item.id);
    itemIdsByVersion.set(versionId, byCode);
    itemCodesByVersion.set(versionId, new Set(byCode.keys()));
  }

  return {
    transactionCodes: new Set([...txnRows].map((r) => r.code)),
    unitCodes: new Set([...unitRows].map((r) => r.code)),
    periodsByLabel: new Map([...periodRows].map((r) => [r.label, r.id])),
    itemIdsByVersion,
    itemCodesByVersion,
  };
}

/**
 * Names for the audit reason.
 *
 * The reason is the "why" non-negotiable 2 demands, and it is read by people
 * — a compiler checking their own work, an auditor answering to a parliament.
 * A reason quoting a UUID is technically a record and practically useless, so
 * anything that goes into one is resolved to the name a person would use.
 * Falls back to the id only when the row has gone.
 */
async function nameOfDataset(claims: RlsClaims, datasetId: string): Promise<string> {
  const rows = await withRls(claims, {}, (tx) =>
    tx.execute(sql`select name from source_dataset where id = ${datasetId}::uuid`),
  );
  const name = (rows as unknown as { name: string }[])[0]?.name;
  return name ? `"${name}"` : datasetId;
}

async function nameOfVintage(claims: RlsClaims, vintageId: string): Promise<string> {
  const rows = await withRls(claims, {}, (tx) =>
    tx.execute(sql`select name from data_vintage where id = ${vintageId}::uuid`),
  );
  const name = (rows as unknown as { name: string }[])[0]?.name;
  return name ? `"${name}"` : vintageId;
}

/**
 * Apply a mapping to a dataset's parsed rows, validate them, and write the
 * result to staging. Re-runnable: staging and issues are replaced wholesale,
 * so a compiler can adjust the mapping and re-validate as often as needed.
 */
export async function stageAndValidate(
  claims: RlsClaims,
  orgId: string,
  datasetId: string,
  file: ParsedFile,
  mapping: MappingDefinition,
  expectedPeriodLabels?: string[],
): Promise<ValidationResult> {
  const datasetName = await nameOfDataset(claims, datasetId);
  return withRls(
    claims,
    { reason: `validate source file ${datasetName}` },
    async (tx) => {
      const context = await loadReferenceContext(tx, orgId, mapping);
      const resolved = resolveRows(file, mapping, context);
      const result = validateRows(file, mapping, resolved, context, {
        expectedPeriodLabels,
      });

      await tx.execute(sql`delete from staging_row where dataset_id = ${datasetId}::uuid`);
      await tx.execute(sql`delete from validation_issue where dataset_id = ${datasetId}::uuid`);

      // Row numbers map to staging ids so issues can be attached to rows.
      const idByRowNumber = new Map<number, string>();
      for (const row of resolved) {
        const inserted = (await tx.execute(sql`
          insert into staging_row (
            org_id, dataset_id, source_row_number, raw, transaction_code,
            activity_item_id, product_item_id, sector_item_id, purpose_item_id,
            period_id, price_basis, valuation, unit_code, value, is_valid
          ) values (
            ${orgId}::uuid, ${datasetId}::uuid, ${row.rowNumber},
            ${JSON.stringify(row.raw)}::jsonb,
            ${row.transactionCode ?? null},
            ${row.activityItemId ?? null}::uuid, ${row.productItemId ?? null}::uuid,
            ${row.sectorItemId ?? null}::uuid, ${row.purposeItemId ?? null}::uuid,
            ${row.periodId ?? null}::uuid,
            ${mapping.priceBasis}::price_basis,
            ${mapping.valuation ?? null}::valuation_basis,
            ${row.unitCode ?? null}, ${row.value ?? null},
            ${!result.invalidRowNumbers.has(row.rowNumber)}
          ) returning id
        `)) as unknown as { id: string }[];
        idByRowNumber.set(row.rowNumber, inserted[0].id);
      }

      for (const issue of result.issues) {
        const stagingId =
          issue.rowNumber === null ? null : idByRowNumber.get(issue.rowNumber) ?? null;
        await tx.execute(sql`
          insert into validation_issue
            (org_id, dataset_id, staging_row_id, severity, code, message, field)
          values (
            ${orgId}::uuid, ${datasetId}::uuid, ${stagingId}::bigint,
            ${issue.severity}::issue_severity, ${issue.code}, ${issue.message},
            ${issue.field ?? null}
          )
        `);
      }

      await tx.execute(sql`
        update source_dataset
           set status = 'validated', row_count = ${resolved.length}
         where id = ${datasetId}::uuid
      `);

      return result;
    },
  );
}

export class CommitBlockedError extends Error {}

/**
 * Promote validated staging rows into observations under a vintage.
 *
 * Refuses while any error-severity issue remains: staging exists precisely so
 * that nothing unchecked reaches the observation table. Warnings do not block
 * — several of them are legitimately possible and a compiler who has looked
 * should not be stopped by the tool.
 */
export async function commitDataset(
  claims: RlsClaims,
  orgId: string,
  datasetId: string,
  vintageId: string,
  mapping: MappingDefinition,
): Promise<{ observationsWritten: number }> {
  const [datasetName, vintageName] = await Promise.all([
    nameOfDataset(claims, datasetId),
    nameOfVintage(claims, vintageId),
  ]);
  return withRls(
    claims,
    { reason: `commit source file ${datasetName} into vintage ${vintageName}` },
    async (tx) => {
      const errors = (await tx.execute(sql`
        select count(*)::int as n from validation_issue
         where dataset_id = ${datasetId}::uuid and severity = 'error'
      `)) as unknown as { n: number }[];
      if (errors[0].n > 0) {
        throw new CommitBlockedError(
          `${errors[0].n} validation error(s) remain; resolve them or adjust the mapping before committing.`,
        );
      }

      const frozen = (await tx.execute(sql`
        select frozen_at from data_vintage where id = ${vintageId}::uuid
      `)) as unknown as { frozen_at: string | null }[];
      if (frozen.length === 0) throw new CommitBlockedError('No such vintage.');
      if (frozen[0].frozen_at !== null) {
        throw new CommitBlockedError(
          'That vintage is frozen. Create a new vintage for revised data.',
        );
      }

      const rows = (await tx.execute(sql`
        select id, transaction_code, activity_item_id, product_item_id,
               sector_item_id, purpose_item_id, period_id, unit_code, value
          from staging_row
         where dataset_id = ${datasetId}::uuid and is_valid
         order by source_row_number
      `)) as unknown as {
        id: string;
        transaction_code: string;
        activity_item_id: string | null;
        product_item_id: string | null;
        sector_item_id: string | null;
        purpose_item_id: string | null;
        period_id: string;
        unit_code: string;
        value: string | null;
      }[];

      let written = 0;
      for (const row of [...rows]) {
        // Find or create the series this coordinate belongs to. NULLS NOT
        // DISTINCT on the unique index makes the upsert behave for the
        // dimensions that are absent.
        const series = (await tx.execute(sql`
          insert into time_series (
            org_id, transaction_code, activity_item_id, product_item_id,
            sector_item_id, purpose_item_id, price_basis, valuation,
            frequency, unit_code
          ) values (
            ${orgId}::uuid, ${row.transaction_code},
            ${row.activity_item_id}::uuid, ${row.product_item_id}::uuid,
            ${row.sector_item_id}::uuid, ${row.purpose_item_id}::uuid,
            ${mapping.priceBasis}::price_basis,
            ${mapping.valuation ?? null}::valuation_basis,
            ${mapping.frequency}::period_frequency, ${row.unit_code}
          )
          on conflict (org_id, transaction_code, activity_item_id, product_item_id,
                       sector_item_id, purpose_item_id, price_basis, valuation, frequency)
          do update set unit_code = excluded.unit_code
          returning id
        `)) as unknown as { id: string }[];

        await tx.execute(sql`
          insert into observation (
            org_id, series_id, period_id, vintage_id, value, origin,
            source_dataset_id, staging_row_id, created_by
          ) values (
            ${orgId}::uuid, ${series[0].id}::uuid, ${row.period_id}::uuid,
            ${vintageId}::uuid, ${row.value}, 'source',
            ${datasetId}::uuid, ${row.id}::bigint, ${claims.sub}::uuid
          )
          on conflict (series_id, period_id, vintage_id)
          do update set value = excluded.value,
                        source_dataset_id = excluded.source_dataset_id,
                        staging_row_id = excluded.staging_row_id
        `);
        written++;
      }

      await tx.execute(sql`
        update source_dataset set status = 'committed' where id = ${datasetId}::uuid
      `);

      return { observationsWritten: written };
    },
  );
}

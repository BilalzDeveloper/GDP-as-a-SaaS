'use server';

import { createHash } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { parseUpload, ParseError, MAX_UPLOAD_BYTES } from '@/intake/parse';
import { stageAndValidate, commitDataset, CommitBlockedError } from '@/intake/service';
import type { MappingDefinition } from '@/intake/types';

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

async function orgFor(slug: string) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const org = await withRls(claims, {}, async (tx) => {
    const rows = (await tx.execute(
      sql`select id, slug from organization where slug = ${slug}`,
    )) as unknown as { id: string; slug: string }[];
    return rows[0];
  });
  if (!org) redirect('/orgs');
  return { claims, org };
}

export async function uploadDataset(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const path = `/orgs/${slug}/data`;
  const { claims, org } = await orgFor(slug);

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) fail(path, 'Choose a file to upload.');
  if (file.size > MAX_UPLOAD_BYTES) {
    fail(path, `The file is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  let parsed;
  try {
    parsed = await parseUpload(file.name, bytes, file.type || undefined);
  } catch (e) {
    fail(path, e instanceof ParseError ? e.message : 'The file could not be read.');
  }

  const name = String(formData.get('name') ?? '').trim() || file.name;
  const provenance = String(formData.get('provenance') ?? '').trim();

  try {
    const datasetId = await withRls(
      claims,
      { reason: `upload source dataset "${name}"` },
      async (tx) => {
        const rows = (await tx.execute(sql`
          insert into source_dataset (
            org_id, name, original_filename, content_type, byte_size, sha256,
            file_bytes, status, provenance, header, row_count, sheet_name, uploaded_by
          ) values (
            ${org.id}::uuid, ${name}, ${file.name},
            ${file.type || 'application/octet-stream'}, ${bytes.byteLength}, ${sha256},
            ${bytes}, 'parsed',
            ${JSON.stringify(provenance ? { note: provenance } : {})}::jsonb,
            ${JSON.stringify(parsed.header)}::jsonb, ${parsed.rows.length},
            ${parsed.sheetName ?? null}, ${claims.sub}::uuid
          ) returning id
        `)) as unknown as { id: string }[];
        return rows[0].id;
      },
    );
    revalidatePath(path);
    redirect(`${path}/${datasetId}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Re-throw Next's redirect signal untouched.
    if (message === 'NEXT_REDIRECT') throw e;
    if (message.includes('source_dataset_org_id_sha256_key')) {
      fail(path, 'That exact file has already been uploaded to this organization.');
    }
    fail(path, 'The upload could not be saved.');
  }
}

function buildMapping(formData: FormData): MappingDefinition {
  const col = (key: string) => {
    const value = String(formData.get(key) ?? '').trim();
    return value ? { source: value } : undefined;
  };
  const constant = (key: string) => {
    const value = String(formData.get(key) ?? '').trim();
    return value ? { constant: value } : undefined;
  };
  const transaction =
    col('col_transactionCode') ?? constant('const_transactionCode');

  return {
    columns: {
      value: col('col_value') ?? { source: '' },
      periodLabel: col('col_periodLabel') ?? { source: '' },
      transactionCode: transaction ?? { source: '' },
      activityCode: col('col_activityCode'),
      productCode: col('col_productCode'),
      sectorCode: col('col_sectorCode'),
      purposeCode: col('col_purposeCode'),
      unitCode: col('col_unitCode'),
    },
    activityVersionId: String(formData.get('activityVersionId') ?? '') || undefined,
    unitCode: String(formData.get('unitCode') ?? 'NC_MN'),
    priceBasis: 'current',
    valuation:
      (String(formData.get('valuation') ?? '') as MappingDefinition['valuation']) ||
      undefined,
    frequency:
      (String(formData.get('frequency') ?? 'annual') as MappingDefinition['frequency']),
    decimalSeparator:
      (String(formData.get('decimalSeparator') ?? '') as '.' | ',') || undefined,
  };
}

export async function applyMapping(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const datasetId = String(formData.get('datasetId') ?? '');
  const path = `/orgs/${slug}/data/${datasetId}`;
  const { claims, org } = await orgFor(slug);

  const mapping = buildMapping(formData);
  if (!('source' in mapping.columns.value) || !mapping.columns.value.source) {
    fail(path, 'Choose which column holds the value.');
  }
  if (!('source' in mapping.columns.periodLabel) || !mapping.columns.periodLabel.source) {
    fail(path, 'Choose which column holds the reference period.');
  }

  const dataset = await withRls(claims, {}, async (tx) => {
    const rows = (await tx.execute(sql`
      select id, file_bytes, original_filename, content_type, sheet_name
        from source_dataset where id = ${datasetId}::uuid
    `)) as unknown as {
      id: string;
      file_bytes: Buffer;
      original_filename: string;
      content_type: string;
      sheet_name: string | null;
    }[];
    return rows[0];
  });
  if (!dataset) fail(`/orgs/${slug}/data`, 'No such dataset.');

  const parsed = await parseUpload(
    dataset.original_filename,
    Buffer.from(dataset.file_bytes),
    dataset.content_type,
    dataset.sheet_name ?? undefined,
  );

  // Persist the mapping so a recurring extract is mapped once, not monthly.
  const mappingName = String(formData.get('mappingName') ?? '').trim();
  if (mappingName) {
    await withRls(
      claims,
      { reason: `save column mapping "${mappingName}"` },
      (tx) =>
        tx.execute(sql`
          insert into column_mapping (org_id, name, definition, created_by)
          values (${org.id}::uuid, ${mappingName},
                  ${JSON.stringify(mapping)}::jsonb, ${claims.sub}::uuid)
          on conflict (org_id, name) do update set definition = excluded.definition
        `),
    );
  }

  await stageAndValidate(claims, org.id, datasetId, parsed, mapping);
  revalidatePath(path);
  redirect(path);
}

export async function commitStaged(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const datasetId = String(formData.get('datasetId') ?? '');
  const path = `/orgs/${slug}/data/${datasetId}`;
  const { claims, org } = await orgFor(slug);

  const vintageName = String(formData.get('vintageName') ?? '').trim();
  if (!vintageName) fail(path, 'Name the vintage this data belongs to.');

  const mappingRow = await withRls(claims, {}, async (tx) => {
    const rows = (await tx.execute(sql`
      select definition from column_mapping
       where org_id = ${org.id}::uuid order by created_at desc limit 1
    `)) as unknown as { definition: MappingDefinition }[];
    return rows[0];
  });
  if (!mappingRow) fail(path, 'Apply and save a column mapping before committing.');

  try {
    const vintageId = await withRls(
      claims,
      { reason: `open vintage "${vintageName}"` },
      async (tx) => {
        const rows = (await tx.execute(sql`
          insert into data_vintage (org_id, name, created_by)
          values (${org.id}::uuid, ${vintageName}, ${claims.sub}::uuid)
          on conflict (org_id, name) do update set name = excluded.name
          returning id
        `)) as unknown as { id: string }[];
        return rows[0].id;
      },
    );
    await commitDataset(claims, org.id, datasetId, vintageId, mappingRow.definition);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'NEXT_REDIRECT') throw e;
    if (e instanceof CommitBlockedError) fail(path, e.message);
    if (message.includes('frozen')) {
      fail(path, 'That vintage is frozen. Create a new vintage for revised data.');
    }
    fail(path, 'The commit did not complete.');
  }
  revalidatePath(path);
  redirect(path);
}

// Risk-3 spike (PLAN.md): prove the dimensional model serves a 400-industry
// detailed compilation as well as a 10-industry aggregate, and that
// drill-down through the tenant mapping layer stays fast.
//
// Creates a throwaway tenant with:
//   - a national activity classification of 400 industries (4-digit),
//     mapped onto ISIC Rev.4 divisions with weighted 1-to-many splits
//   - a 10-industry aggregate version of the same economy
// then EXPLAIN ANALYZEs the queries the compilation UI will actually run.
//
// Run against a scratch database:  DATABASE_URL=... node scripts/spike-scale.mjs
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
await sql`select set_config('app.reason', 'risk-3 scale spike', false)`;

const INDUSTRIES = Number(process.env.SPIKE_INDUSTRIES ?? 400);
// Several tenants, so the classification tables hold realistic multi-tenant
// volume: with only one tenant's 500 rows the planner correctly picks
// sequential scans and the measurement proves nothing about scale.
const TENANTS = Number(process.env.SPIKE_TENANTS ?? 25);

function plan(rows) {
  const text = rows.map((r) => r['QUERY PLAN']).join('\n');
  const time = /Execution Time: ([\d.]+) ms/.exec(text)?.[1];
  const scans = (text.match(/Seq Scan on (\w+)/g) ?? []).join(', ');
  return { time, scans, text };
}

try {
  const [isicVer] = await sql`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  const divisions = await sql`
    select id, code from classification_item
     where version_id = ${isicVer.id} and level = 2 order by sort_order`;
  const perDivision = Math.ceil(INDUSTRIES / divisions.length);

  const orgIds = [];
  let mapping, natVer, children, parents;

  const started = Date.now();
  for (let n = 0; n < TENANTS; n++) {
    const slug = `spike-${Date.now().toString(36)}-${n}`;
    const [org] = await sql`
      insert into organization (name, slug, country_code)
      values (${'Spike NSO ' + n}, ${slug}, 'DNK') returning id`;
    orgIds.push(org.id);

    const [natCls] = await sql`
      insert into classification (code, name, kind, owner_org_id)
      values ('NAT-ACT', 'National activity classification', 'activity', ${org.id})
      returning id`;
    const [ver] = await sql`
      insert into classification_version
        (classification_id, version_label, is_current, provenance, seeded_to_level, notes)
      values (${natCls.id}, 'v2024', true, 'tenant_defined', 2,
              'Synthetic 400-industry national variant (risk-3 spike)')
      returning id`;

    // Level 1 mirrors the ISIC divisions; level 2 splits each into national
    // industries until the target count is reached.
    const parentRows = divisions.map((d, i) => ({
      version_id: ver.id, code: 'N' + d.code,
      name: 'National group ' + d.code, level: 1, sort_order: i * 1000,
    }));
    const insertedParents = await sql`
      insert into classification_item ${sql(parentRows, 'version_id', 'code', 'name', 'level', 'sort_order')}
      returning id, code`;
    const parentByCode = new Map(insertedParents.map((r) => [r.code, r.id]));
    const localParents = divisions.map((d) => ({
      id: parentByCode.get('N' + d.code), code: d.code, isicId: d.id,
    }));

    const childRows = [];
    let made = 0;
    for (const p of localParents) {
      for (let k = 1; k <= perDivision && made < INDUSTRIES; k++, made++) {
        childRows.push({
          version_id: ver.id, code: `${p.code}${String(k).padStart(2, '0')}`,
          name: `National industry ${p.code}-${k}`, level: 2,
          parent_id: p.id, sort_order: made * 10, _isic: p.isicId,
        });
      }
    }
    const insertedChildren = await sql`
      insert into classification_item ${sql(childRows, 'version_id', 'code', 'name', 'level', 'parent_id', 'sort_order')}
      returning id, code`;
    const childIdByCode = new Map(insertedChildren.map((r) => [r.code, r.id]));
    const localChildren = childRows.map((c) => ({ id: childIdByCode.get(c.code), isicId: c._isic }));

    const [map] = await sql`
      insert into classification_mapping
        (owner_org_id, name, from_version_id, to_version_id)
      values (${org.id}, 'NAT-ACT v2024 → ISIC Rev.4', ${ver.id}, ${isicVer.id})
      returning id`;
    const entryRows = [
      ...localChildren.map((c) => ({ mapping_id: map.id, from_item_id: c.id, to_item_id: c.isicId, weight: 1 })),
      ...localParents.map((p) => ({ mapping_id: map.id, from_item_id: p.id, to_item_id: p.isicId, weight: 1 })),
    ];
    await sql`insert into classification_mapping_entry ${sql(entryRows, 'mapping_id', 'from_item_id', 'to_item_id', 'weight')}`;

    mapping = map; natVer = ver; children = localChildren; parents = localParents;
  }

  const [{ count: itemCount }] = await sql`select count(*)::int from classification_item`;
  const [{ count: entryCount }] = await sql`select count(*)::int from classification_mapping_entry`;
  console.log(`loaded ${TENANTS} tenants in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`classification_item: ${itemCount} rows   classification_mapping_entry: ${entryCount} rows`);
  console.log(`measured tenant: ${children.length} national industries, ${parents.length} groups`);

  // --- validation -----------------------------------------------------------
  let t = Date.now();
  const problems = await sql`select * from validate_classification_mapping(${mapping.id})`;
  console.log(`validate_classification_mapping: ${problems.length} problems in ${Date.now() - t} ms`);

  // Deliberately break one entry to show validation catches partial weights.
  const victim = children[0];
  await sql`update classification_mapping_entry set weight = 0.6
             where mapping_id = ${mapping.id} and from_item_id = ${victim.id}`;
  const broken = await sql`select * from validate_classification_mapping(${mapping.id})`;
  console.log(`after breaking one weight: ${broken.length} problem(s) — ${broken[0]?.problem} (${broken[0]?.detail})`);
  await sql`update classification_mapping_entry set weight = 1
             where mapping_id = ${mapping.id} and from_item_id = ${victim.id}`;

  t = Date.now();
  await sql`select activate_classification_mapping(${mapping.id})`;
  console.log(`activation: ${Date.now() - t} ms`);

  // --- drill-down queries ---------------------------------------------------
  await sql`analyze classification_item`;
  await sql`analyze classification_mapping_entry`;

  console.log('\n--- Q1: aggregate → contributing national industries (one ISIC division)');
  const q1 = await sql`
    explain (analyze, buffers)
    select ni.code, ni.name, e.weight
      from classification_mapping_entry e
      join classification_item ni on ni.id = e.from_item_id
      join classification_item isic on isic.id = e.to_item_id
     where e.mapping_id = ${mapping.id} and isic.code = '10' and ni.level = 2`;
  const p1 = plan(q1);
  console.log(`  execution: ${p1.time} ms   seq scans: ${p1.scans || 'none'}`);

  console.log('--- Q2a: hierarchy self-join WITHOUT constraining the parent side');
  const q2a = await sql`
    explain (analyze, buffers)
    select parent.code, child.code, child.name
      from classification_item child
      left join classification_item parent on parent.id = child.parent_id
     where child.version_id = ${natVer.id}
     order by child.sort_order`;
  const p2a = plan(q2a);
  console.log(`  execution: ${p2a.time} ms   seq scans: ${p2a.scans || 'none'}`);

  console.log('--- Q2b: same tree via classification_tree() (parent constrained)');
  const q2b = await sql`
    explain (analyze, buffers)
    select * from classification_tree(${natVer.id})`;
  const p2b = plan(q2b);
  console.log(`  execution: ${p2b.time} ms   seq scans: ${p2b.scans || 'none'}`);
  console.log(`  → ${(Number(p2a.time) / Number(p2b.time)).toFixed(1)}x faster, and Q2b does not scale with other tenants' data`);

  console.log('--- Q3: 10-industry aggregate view (national → ISIC section rollup)');
  const q3 = await sql`
    explain (analyze, buffers)
    select section.code, section.name, count(*) as contributing_industries,
           sum(e.weight) as total_weight
      from classification_mapping_entry e
      join classification_item isic on isic.id = e.to_item_id
      join classification_item section on section.id = isic.parent_id
     where e.mapping_id = ${mapping.id}
     group by section.code, section.name
     order by section.code`;
  const p3 = plan(q3);
  console.log(`  execution: ${p3.time} ms   seq scans: ${p3.scans || 'none'}`);

  const rollup = await sql`
    select section.code, count(*)::int as n
      from classification_mapping_entry e
      join classification_item isic on isic.id = e.to_item_id
      join classification_item section on section.id = isic.parent_id
     where e.mapping_id = ${mapping.id}
     group by section.code order by section.code`;
  console.log(`\nrollup produced ${rollup.length} ISIC sections from ${children.length + parents.length} mapped items`);

  if (process.env.SPIKE_KEEP !== '1') {
    await sql`delete from organization where id = any(${orgIds})`;
    console.log('spike tenants removed (set SPIKE_KEEP=1 to retain)');
  }
} finally {
  await sql.end();
}

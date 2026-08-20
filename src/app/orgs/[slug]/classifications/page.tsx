import { notFound, redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { withRls, schema } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { OrgShell, Panel } from '@/components/shell';

export const dynamic = 'force-dynamic';

type VersionRow = {
  classification_code: string;
  classification_name: string;
  kind: string;
  owner_org_id: string | null;
  version_label: string;
  provenance: 'official_file' | 'transcribed_pending_verification' | 'tenant_defined';
  seeded_to_level: number;
  item_count: number;
  notes: string | null;
  source_url: string | null;
};

type MappingRow = {
  id: string;
  name: string;
  activated_at: string | null;
  entry_count: number;
};

// Deliberately explicit wording: a compiler must never mistake transcribed
// reference data for data verified against the official publication, and must
// never assume a version goes deeper than it does. See docs/reference-data.md.
const PROVENANCE: Record<
  VersionRow['provenance'],
  { label: string; tone: string }
> = {
  official_file: { label: 'Official file', tone: 'pill is-positive' },
  transcribed_pending_verification: {
    label: 'Awaiting verification',
    tone: 'pill is-warning',
  },
  tenant_defined: { label: 'Defined here', tone: 'pill' },
};

const LEVEL_NAME: Record<string, string[]> = {
  ISIC4: ['section', 'division', 'group', 'class'],
  CPC21: ['section', 'division', 'group', 'class', 'subclass'],
};

function depthLabel(code: string, level: number) {
  const names = LEVEL_NAME[code];
  return names?.[level - 1] ? `to ${names[level - 1]}` : `to level ${level}`;
}

export default async function ClassificationsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const { slug } = await params;

  const data = await withRls(claims, {}, async (tx) => {
    const [org] = await tx
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug));
    if (!org) return null;

    const versions = (await tx.execute(sql`
      select c.code as classification_code, c.name as classification_name,
             c.kind, c.owner_org_id, v.version_label, v.provenance,
             v.seeded_to_level, v.notes, v.source_url,
             (select count(*)::int from classification_item i
               where i.version_id = v.id) as item_count
        from classification_version v
        join classification c on c.id = v.classification_id
       order by (c.owner_org_id is not null), c.code, v.version_label
    `)) as unknown as VersionRow[];

    const mappings = (await tx.execute(sql`
      select m.id, m.name, m.activated_at,
             (select count(*)::int from classification_mapping_entry e
               where e.mapping_id = m.id) as entry_count
        from classification_mapping m
       where m.owner_org_id = ${org.id}
       order by m.created_at
    `)) as unknown as MappingRow[];

    return { org, versions: [...versions], mappings: [...mappings] };
  });

  if (!data) notFound();
  const { org, versions, mappings } = data;
  const standards = versions.filter((v) => v.owner_org_id === null);
  const own = versions.filter((v) => v.owner_org_id !== null);
  const unverified = standards.filter(
    (v) => v.provenance === 'transcribed_pending_verification',
  ).length;

  return (
    <>
      <OrgShell
        slug={org.slug}
        orgName={org.name}
        email={claims.email}
        current="classifications"
      />
      <main>
        <h1>Classifications</h1>
        <p className="lede">
          The standards every compilation is expressed in, and this
          organization&apos;s own national adaptations mapped onto them.
        </p>

        {unverified > 0 && (
          <div className="callout is-warning">
            <p className="callout-title">
              {unverified} classification{unverified === 1 ? '' : 's'} awaiting
              verification
            </p>
            <p className="muted" style={{ margin: 0 }}>
              These were transcribed from the published structure and have not
              yet been diffed against the official file. Load the official file
              to verify them — until then, treat the codes as provisional.
            </p>
          </div>
        )}

        <Panel title="Standards" scroll>
          <table>
            <thead>
              <tr>
                <th>Classification</th>
                <th>Version</th>
                <th className="num">Items</th>
                <th>Depth</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {standards.map((v) => (
                <tr key={`${v.classification_code}-${v.version_label}`}>
                  <td>
                    <span className="mono">{v.classification_code}</span>
                    <br />
                    <span className="muted">{v.classification_name}</span>
                  </td>
                  <td className="mono">{v.version_label}</td>
                  <td className="num">{v.item_count}</td>
                  <td className="muted">
                    {depthLabel(v.classification_code, v.seeded_to_level)}
                  </td>
                  <td>
                    <span className={PROVENANCE[v.provenance].tone}>
                      {PROVENANCE[v.provenance].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <p className="muted">
          Depth is the deepest level present — a classification shown to
          division level does not contain groups or classes yet.
        </p>

        <h2>This organization&apos;s classifications</h2>
        {own.length === 0 ? (
          <p className="empty">
            None yet. National adaptations are defined here and mapped onto the
            standards above.
          </p>
        ) : (
          <Panel scroll>
            <table>
              <thead>
                <tr>
                  <th>Classification</th>
                  <th>Version</th>
                  <th className="num">Items</th>
                  <th>Depth</th>
                </tr>
              </thead>
              <tbody>
                {own.map((v) => (
                  <tr key={`${v.classification_code}-${v.version_label}`}>
                    <td>
                      <span className="mono">{v.classification_code}</span>
                      <br />
                      <span className="muted">{v.classification_name}</span>
                    </td>
                    <td className="mono">{v.version_label}</td>
                    <td className="num">{v.item_count}</td>
                    <td className="muted">
                      {depthLabel(v.classification_code, v.seeded_to_level)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        <h2>Mappings</h2>
        {mappings.length === 0 ? (
          <p className="empty">
            No mappings yet. A mapping relates one of this organization&apos;s
            classifications to a standard, and must pass validation before it
            can be activated.
          </p>
        ) : (
          <Panel scroll>
            <table>
              <thead>
                <tr>
                  <th>Mapping</th>
                  <th className="num">Entries</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="num">{m.entry_count}</td>
                    <td>
                      {m.activated_at ? (
                        <span className="pill is-positive">
                          Active since{' '}
                          {new Date(m.activated_at).toISOString().slice(0, 10)}
                        </span>
                      ) : (
                        <span className="pill is-warning">Draft</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </main>
    </>
  );
}

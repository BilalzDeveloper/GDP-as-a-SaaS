import Link from 'next/link';
import { IdentityBar, Panel } from '@/components/shell';
import { getVerifiedClaims } from '@/lib/supabase/server';

export const metadata = {
  title: 'User guide — SNA Compilation Platform',
  description:
    'How to compile GDP on this platform: source data, mapping, runs, review and publication.',
};

/**
 * The user guide.
 *
 * Written for the person compiling the accounts, not for the person
 * maintaining the code — `docs/` is the second audience and stays where it
 * is. Public on purpose: it names no tenant and holds no figures, and someone
 * evaluating the platform before they have an account is exactly who needs
 * it. It is a Server Component with no data access at all, so there is
 * nothing here for row-level security to protect.
 *
 * Keep it truthful. Every button name, message and rule below is the one the
 * application actually uses; when behaviour changes, this page changes in the
 * same commit.
 */

/** One numbered step of the compilation walk-through. */
function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="guide-step">
      <h3>
        <span className="guide-step-n">{n}</span> {title}
      </h3>
      {children}
    </section>
  );
}

const CONTENTS = [
  ['what-it-does', 'What this platform does'],
  ['roles', 'Roles and permissions'],
  ['compiling', 'Compiling: the seven steps'],
  ['file-format', 'Preparing your source file'],
  ['codes', 'Transaction codes'],
  ['sectors', 'Institutional sectors'],
  ['sector-value-added', 'Value added by sector'],
  ['adjustments', 'FISIM and imputed rent'],
  ['results', 'Reading the results'],
  ['volumes', 'Volume measures and non-additivity'],
  ['quarterly', 'Quarterly accounts'],
  ['publication', 'Review, embargo and publication'],
  ['audit', 'The audit trail'],
  ['refusals', 'When the platform refuses to compile'],
  ['messages', 'What the messages mean'],
  ['limits', 'Known limitations'],
] as const;

export default async function HelpPage() {
  // Signed in or not: the guide is the same page either way, and someone
  // evaluating the platform before they have an account is exactly who needs
  // it. Reading the claims only decides whether the identity bar offers a way
  // back in.
  const claims = await getVerifiedClaims();

  return (
    <>
      <IdentityBar email={claims?.email} />
      <main className="guide">
        <h1>User guide</h1>
        <p className="lede">
          How to take source data from a survey, an administrative register or
          a set of government accounts, and turn it into a GDP estimate you can
          defend line by line.
        </p>

        <Panel title="On this page">
          <ul className="guide-contents">
            {CONTENTS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </Panel>

        <h2 id="what-it-does">What this platform does</h2>
        <p>
          It compiles Gross Domestic Product under the{' '}
          <strong>UN System of National Accounts (SNA 2008)</strong> by all
          three approaches — production, expenditure and income — from source
          data you upload, and keeps a complete record of how each figure was
          arrived at.
        </p>
        <p>Three properties shape everything about how it behaves:</p>
        <ul>
          <li>
            <strong>Reproducibility.</strong> Every published figure can be
            recomputed from the stored inputs and the method version pinned to
            the run. Nothing is edited in place; a correction is a new vintage,
            never an overwrite of the old one.
          </li>
          <li>
            <strong>Auditability.</strong> Every change records who made it,
            when, what changed and <em>why</em>. A write that carries no reason
            is refused by the database rather than recorded blank.
          </li>
          <li>
            <strong>Isolation.</strong> Your organization&apos;s data is
            invisible to every other organization, enforced in the database
            itself rather than only in the application. A pre-release estimate
            is market-sensitive, so this is treated as a safety property, not a
            feature.
          </li>
        </ul>
        <p className="muted">
          It does not adjust your figures to make them agree. Where the three
          approaches differ, the difference is reported as a statistical
          discrepancy and left in view.
        </p>

        <h2 id="roles">Roles and permissions</h2>
        <p>
          Everyone in an organization holds exactly one role. An admin sets
          them on the organization&apos;s <strong>Overview</strong> page with{' '}
          <strong>Add member</strong>, using the person&apos;s account email —
          so they must have registered first.
        </p>
        <Panel scroll>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Can do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>admin</strong>
                </td>
                <td>
                  Everything a compiler can, plus adding and removing members
                  and publishing an approved run.
                </td>
              </tr>
              <tr>
                <td>
                  <strong>compiler</strong>
                </td>
                <td>
                  Define reference periods, upload and map source files, commit
                  vintages, create and execute runs, submit a run for review.
                </td>
              </tr>
              <tr>
                <td>
                  <strong>reviewer</strong>
                </td>
                <td>
                  Read everything, and approve or send back a run submitted for
                  review — but never a run they created themselves.
                </td>
              </tr>
              <tr>
                <td>
                  <strong>viewer</strong>
                </td>
                <td>Read everything. Change nothing.</td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <p>
          <strong>Separation of duties is enforced, not advised.</strong> The
          person who created a run cannot approve it, whatever role they hold.
          The attempt is refused with{' '}
          <em>
            &ldquo;a run cannot be reviewed by the person who created it; ask
            another reviewer&rdquo;
          </em>
          .
        </p>

        <h2 id="compiling">Compiling: the seven steps</h2>

        <Step n={1} title="Define your reference periods">
          <p>
            <strong>Source data → Reference periods.</strong> Give the fiscal
            year and whether you want annual periods, quarterly, or both.
          </p>
          <p>
            Do this first: an uploaded row whose period does not exist yet
            cannot be filed anywhere, and will fail validation with{' '}
            <code>unknown_period</code>.
          </p>
          <p>
            Fiscal years that do not start in January are supported. A year
            labelled 2024 running July 2024 to June 2025 is defined once here
            and every later figure inherits it.
          </p>
        </Step>

        <Step n={2} title="Upload a source file">
          <p>
            <strong>Source data → Upload a file.</strong> CSV or XLSX. Give it
            a name you will recognise later, and a line of{' '}
            <strong>provenance</strong> — where the data came from.
          </p>
          <p>
            The provenance line is not decoration. It is what a reviewer reads
            when they ask where a number came from, and it appears next to the
            file&apos;s checksum in the drill-down. &ldquo;Quarterly business
            survey, weighted estimates, extracted 12 March&rdquo; is useful;
            &ldquo;data&rdquo; is not.
          </p>
          <p>
            The file is stored whole, with a SHA-256 checksum, so the bytes you
            uploaded can always be compared with the bytes that were compiled.
          </p>
        </Step>

        <Step n={3} title="Map the columns">
          <p>
            <strong>Map the columns</strong>, on the dataset&apos;s own page.
            Tell the platform which of your columns holds the value, the
            period, the transaction code, and — where you have them — the
            activity and institutional sector codes.
          </p>
          <p>
            Choose the classification version each code column should resolve
            against: <code>ISIC4</code> for activities, <code>SNA_SECTOR</code>{' '}
            for institutional sectors, or a national variant your organization
            has defined. A code column mapped without a version cannot resolve
            and every row will fail.
          </p>
          <p>
            Set the unit for the whole file, and the valuation if the file is
            output data. Then <strong>Apply mapping and validate</strong>.
          </p>
        </Step>

        <Step n={4} title="Read the validation, then commit">
          <p>
            Nothing reaches your accounts until you commit it. Validation
            reports what it found — unparseable numbers, unknown codes,
            duplicate coordinates, coverage gaps, magnitude jumps — against the
            row and column it came from.
          </p>
          <p>
            Fix what needs fixing in the source file and re-upload, or accept
            what is only a warning. Then name a <strong>vintage</strong> and{' '}
            <strong>Commit staged rows</strong>.
          </p>
          <p>
            A vintage is a named, append-only set of observations — &ldquo;2024
            first estimate&rdquo;, &ldquo;2024 revised&rdquo;. Several files
            commit into the same vintage. A vintage is frozen when a run
            reading it is approved, and a frozen vintage never changes again.
          </p>
        </Step>

        <Step n={5} title="Create a run">
          <p>
            <strong>Compilation runs → New run.</strong> A run is one named
            compilation exercise. It fixes:
          </p>
          <ul>
            <li>
              <strong>the vintage</strong> it reads — which is what makes it
              reproducible;
            </li>
            <li>
              <strong>the balancing anchor</strong> — which approach is
              published as the headline. The others are reported with their
              discrepancy and never adjusted to agree;
            </li>
            <li>
              <strong>the frequency</strong>, and for a quarterly run, the
              annual run it is benchmarked to;
            </li>
            <li>
              <strong>the volume settings</strong> — a reference period and an
              index formula, if you want constant-price figures;
            </li>
            <li>
              <strong>the FISIM treatment</strong>, and whether your household
              consumption figure already includes imputed rent.
            </li>
          </ul>
          <p>
            All of these are recorded as the run&apos;s{' '}
            <strong>method version</strong> when it executes. Changing any of
            them is a different method, producing different figures — which is
            why they are chosen per run rather than set globally.
          </p>
        </Step>

        <Step n={6} title="Execute it">
          <p>
            <strong>Execute</strong> on the run&apos;s page. The engine
            compiles every period in the vintage and writes the results, the
            diagnostics, and — for each figure — the observations it was summed
            from.
          </p>
          <p>
            Executing again gives the same numbers, because the vintage and the
            method are both fixed. That is the guarantee, and it is worth
            testing on your own data: press <strong>Re-execute</strong> and
            check nothing moves.
          </p>
        </Step>

        <Step n={7} title="Review, then publish">
          <p>
            <strong>Submit for review</strong>, have a second person approve
            it, then an admin <strong>publishes</strong> — optionally under
            embargo. See <a href="#publication">Review, embargo and publication</a>{' '}
            below.
          </p>
        </Step>

        <h2 id="file-format">Preparing your source file</h2>
        <p>
          There is no fixed column layout — you map your own columns in step 3.
          What matters is that each row is one observation: a value, a period,
          a transaction code, and whatever dimensions apply to it.
        </p>
        <Panel scroll>
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th>Required</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Value</td>
                <td>yes</td>
                <td>
                  A blank cell means &ldquo;explicitly missing&rdquo; and is
                  kept as such. It is not read as zero.
                </td>
              </tr>
              <tr>
                <td>Reference period</td>
                <td>yes</td>
                <td>
                  Must match a period you have defined — <code>2024</code>,{' '}
                  <code>2024-Q1</code>.
                </td>
              </tr>
              <tr>
                <td>Transaction code</td>
                <td>yes</td>
                <td>
                  Per row, or one code for the whole file if it holds a single
                  transaction.
                </td>
              </tr>
              <tr>
                <td>Activity code</td>
                <td>for P.1 and P.2</td>
                <td>
                  Output and intermediate consumption must say which industry
                  they belong to.
                </td>
              </tr>
              <tr>
                <td>Institutional sector</td>
                <td>for consumption</td>
                <td>
                  See <a href="#sectors">Institutional sectors</a>.
                </td>
              </tr>
              <tr>
                <td>Unit</td>
                <td>per file</td>
                <td>
                  Every figure in one compilation must share a unit. Mixing
                  millions and thousands is reported, never summed.
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <p>
          <strong>Signs.</strong> Enter imports (P.7) and subsidies (D.31, D.3)
          as <em>positive</em> amounts. The engine subtracts them. Figures that
          are already negative are detected and reported rather than
          double-negated. Changes in inventories (P.52) may legitimately be
          negative and are accepted either way.
        </p>
        <p>
          <strong>Decimal separators.</strong> Both <code>1234.56</code> and{' '}
          <code>1234,56</code> are read. Where a file is genuinely ambiguous the
          rows are flagged rather than guessed at; set the separator explicitly
          in the mapping if that happens.
        </p>

        <h2 id="codes">Transaction codes</h2>
        <p>
          These are the SNA 2008 codes the compilation reads. Anything else is
          stored but does not enter an aggregate.
        </p>
        <Panel scroll>
          <table>
            <thead>
              <tr>
                <th>Approach</th>
                <th>Code</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td rowSpan={4}>Production</td>
                <td className="mono">P.1</td>
                <td>Output, by industry, at basic prices</td>
              </tr>
              <tr>
                <td className="mono">P.2</td>
                <td>Intermediate consumption, by industry</td>
              </tr>
              <tr>
                <td className="mono">D.21</td>
                <td>Taxes on products — required, or no production GDP</td>
              </tr>
              <tr>
                <td className="mono">D.31</td>
                <td>Subsidies on products (positive amount)</td>
              </tr>
              <tr>
                <td rowSpan={6}>Expenditure</td>
                <td className="mono">P.3 · P.31 · P.32</td>
                <td>
                  Final consumption — see{' '}
                  <a href="#sectors">Institutional sectors</a>
                </td>
              </tr>
              <tr>
                <td className="mono">P.51g</td>
                <td>Gross fixed capital formation</td>
              </tr>
              <tr>
                <td className="mono">P.52</td>
                <td>Changes in inventories (may be negative)</td>
              </tr>
              <tr>
                <td className="mono">P.53</td>
                <td>Acquisitions less disposals of valuables</td>
              </tr>
              <tr>
                <td className="mono">P.6</td>
                <td>Exports</td>
              </tr>
              <tr>
                <td className="mono">P.7</td>
                <td>Imports (positive amount)</td>
              </tr>
              <tr>
                <td rowSpan={5}>Income</td>
                <td className="mono">D.1</td>
                <td>Compensation of employees</td>
              </tr>
              <tr>
                <td className="mono">B.2g</td>
                <td>Gross operating surplus</td>
              </tr>
              <tr>
                <td className="mono">B.3g</td>
                <td>Gross mixed income</td>
              </tr>
              <tr>
                <td className="mono">D.2</td>
                <td>Taxes on production and imports</td>
              </tr>
              <tr>
                <td className="mono">D.3</td>
                <td>Subsidies (positive amount)</td>
              </tr>
              <tr>
                <td>Memorandum</td>
                <td className="mono">POP</td>
                <td>
                  Mid-year resident population, for per-capita GDP. Never
                  summed into any aggregate.
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <p className="muted">
          <code>POP</code> is not a transaction. SNA 2008 treats population as
          a memorandum item presented alongside the accounts, and the platform
          marks it as one so it can never reach a total. Give it its own unit —{' '}
          <code>PERSONS</code> or <code>PERSONS_TH</code> — rather than the
          currency unit of the accounts.
        </p>

        <h2 id="sectors">Institutional sectors</h2>
        <p>
          Final consumption is the one place where the same transaction is told
          apart by <em>who</em> did the consuming. Map a sector column against{' '}
          <code>SNA_SECTOR</code> and it resolves to the right component:
        </p>
        <Panel scroll>
          <table>
            <thead>
              <tr>
                <th>Sector</th>
                <th>Becomes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">S.14</td>
                <td>Household final consumption</td>
              </tr>
              <tr>
                <td className="mono">S.15</td>
                <td>NPISH final consumption</td>
              </tr>
              <tr>
                <td className="mono">S.13</td>
                <td>Government final consumption</td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <p>
          Sub-sectors roll up: if you keep central, state and local government
          separately on <code>S.1311</code>, <code>S.1312</code> and{' '}
          <code>S.1313</code>, they still produce one government figure.
        </p>
        <p>
          <strong>If you keep no sector dimension</strong>, leave the column
          unmapped. The transaction code then resolves it — but only where the
          code names a sector unambiguously: <code>P.31</code> for households,{' '}
          <code>P.32</code> for government. Two consequences follow:
        </p>
        <ul>
          <li>
            An unqualified <code>P.3</code> is <strong>not</strong> read as any
            sector&apos;s consumption. With no sector it is households, NPISH
            and government together, so reading it as government&apos;s would
            double-count it against the household figure beside it.
          </li>
          <li>
            <code>P.32</code> alone <strong>understates</strong> government
            consumption. It is collective consumption only, and government also
            provides individual services to households — health and education
            above all. The figure is used and the shortfall is reported. File
            against <code>S.13</code> to have both parts counted.
          </li>
        </ul>
        <p>
          Supplying both a sector split and a total-economy figure for the same
          sector is refused: one is a double count and the other a residual, and
          only you know which.
        </p>

        <h2 id="sector-value-added">Value added by sector</h2>
        <p>
          Every producer belongs both to an industry — what it makes — and to
          an institutional sector — what kind of unit it is (SNA 2008 ch.4). If
          your <code>P.1</code> and <code>P.2</code> rows carry a sector as
          well as an activity, the run produces a second cut of value added
          alongside the industry one, and general government or household value
          added becomes a table you can publish.
        </p>
        <p>
          Nothing extra to switch on: map the sector column, and if production
          rows carry one the panel appears. Sub-sectors are kept at whatever
          level of detail you file them, unlike final consumption where they
          roll up.
        </p>
        <p>
          <strong>It is value added, never GDP.</strong> Taxes and subsidies on
          products are levied on products rather than on producers and cannot
          be attributed to a sector (SNA 2008 §7.88), so there is no sector
          figure to add them to and the platform compiles none.
        </p>
        <p>
          <strong>It is computed before the FISIM and imputed-rent
          adjustments.</strong> Those are attributed to industries — FISIM to
          the industries consuming it, imputed rent to the housing industry —
          and your data gives no sector to attribute them to. Rather than
          guess, the sector cut is the unadjusted account, so it will not equal
          the adjusted industry total when a compilation carries adjustments.
        </p>
        <p>
          <strong>Partial coverage is reported.</strong> If some producers
          carry no sector, the sector figures are shown with a note saying what
          they total against the industry cut and by how much they fall short.
          A partial breakdown is useful once it is labelled as one; published
          as though it were complete it would understate whichever sectors the
          uncovered producers belong to, and nothing on the face of the table
          would show it.
        </p>

        <h2 id="adjustments">FISIM and imputed rent</h2>
        <p>
          Both are adjustments the SNA describes but gives no ordinary
          transaction code for, so the platform defines its own. They are
          applied by the engine rather than summed into a total.
        </p>
        <Panel scroll>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Carries an industry?</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">FISIM.P1</td>
                <td>no</td>
                <td>Total FISIM output of financial corporations</td>
              </tr>
              <tr>
                <td className="mono">FISIM.P2</td>
                <td>
                  <strong>yes</strong>
                </td>
                <td>FISIM consumed by that industry as an input</td>
              </tr>
              <tr>
                <td className="mono">FISIM.P31</td>
                <td>no</td>
                <td>FISIM in household final consumption</td>
              </tr>
              <tr>
                <td className="mono">FISIM.P3</td>
                <td>no</td>
                <td>FISIM in government final consumption</td>
              </tr>
              <tr>
                <td className="mono">FISIM.P6</td>
                <td>no</td>
                <td>FISIM supplied to non-residents</td>
              </tr>
              <tr>
                <td className="mono">IMPRENT.P1</td>
                <td>
                  <strong>yes</strong>
                </td>
                <td>
                  Imputed output of owner-occupied dwelling services, typically
                  ISIC division 68
                </td>
              </tr>
              <tr>
                <td className="mono">IMPRENT.P2</td>
                <td>
                  <strong>the same one</strong>
                </td>
                <td>Inputs to that imputed production</td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <p>
          <strong>Two rules, and breaking either produces a figure that looks
          reasonable and is wrong.</strong>
        </p>
        <ul>
          <li>
            <strong>
              Do not include FISIM in the <code>P.2</code> you upload.
            </strong>{' '}
            The industry&apos;s ordinary intermediate consumption must exclude
            the FISIM allocated to it; the engine adds that from{' '}
            <code>FISIM.P2</code>. Supplying it in both double-counts.
          </li>
          <li>
            <strong>
              The allocations must sum to <code>FISIM.P1</code>.
            </strong>{' '}
            A shortfall is reported as{' '}
            <code>fisim_allocation_mismatch</code> rather than absorbed
            quietly.
          </li>
        </ul>
        <p>
          A half-specified adjustment is not compiled at all: a total with
          nothing allocated, an allocation with no total, an allocation with no
          industry, or imputed rent whose output and inputs name two different
          industries. The rest of the account still compiles; the run tells you
          which adjustment was withheld and why.
        </p>

        <h2 id="results">Reading the results</h2>
        <p>An executed run shows, in order:</p>
        <ul>
          <li>
            <strong>GDP at market prices, by approach</strong> — each approach
            that had enough data, and the headline from your anchor. A dash
            means that approach was not compiled; the diagnostics say what was
            missing.
          </li>
          <li>
            <strong>Components</strong> — what each approach was built from,
            with a <strong>sources</strong> link on every line.
          </li>
          <li>
            <strong>Statistical discrepancy</strong> — anchor minus each other
            approach, so a positive figure means that approach falls short of
            the headline. Reported, never removed.
          </li>
          <li>
            <strong>Per capita and growth</strong> — per-capita GDP in units of
            the currency (not in the millions the accounts are compiled in),
            with growth period-on-period and, sub-annually, year-on-year.
          </li>
          <li>
            <strong>Value added by industry</strong> — output, intermediate
            consumption and value added for each, again with sources.
          </li>
        </ul>
        <p>
          <strong>The sources link is the point of the product.</strong> It
          shows the observations that produced that exact figure: the
          transaction, the industry and sector each row carried, the file it
          came from with its checksum, the row number, and the raw cells
          exactly as uploaded. That record is written when the run executes, so
          it reflects what <em>that run</em> summed — not what today&apos;s
          rules would select.
        </p>
        <p className="muted">
          Figures derived from other figures — per-capita, growth rates — have
          no source observations, and are shown without a link rather than with
          one leading to an empty table.
        </p>

        <h2 id="volumes">Volume measures and non-additivity</h2>
        <p>
          Name a volume reference period and an index formula when creating the
          run, and supply deflators in the vintage, and you get chain-linked
          volume measures alongside the current-price figures.
        </p>
        <p>
          <strong>
            Chain-linked volumes do not add up, and this is not a defect.
          </strong>{' '}
          Chain-linked industry figures will not sum to the chain-linked total,
          because each series is linked using its own price structure. Every
          national statistical office publishing chained volumes has this
          property, and the platform states it on the page rather than hiding
          it — because it is the single most commonly reported non-bug in
          national accounts software.
        </p>
        <p>
          Laspeyres, Paasche and Fisher are all available. Chain-linking uses
          the annual overlap method.
        </p>

        <h2 id="quarterly">Quarterly accounts</h2>
        <p>
          A quarterly run can be <strong>benchmarked</strong> to an executed
          annual run: the quarters are adjusted so they sum exactly to the
          annual figures while keeping the movement your quarterly source data
          shows. That is the Denton proportional method; an additive variant is
          available for series that cross zero.
        </p>
        <p>
          Quarters after the last annual year are extrapolated, flagged as
          such, and will be revised when those annual accounts are compiled.
        </p>
        <p>
          An unbenchmarked quarterly run says so plainly: its quarters are not
          guaranteed to sum to the annual accounts, and publishing both without
          reconciling them would put two different figures for the same year
          into the public record.
        </p>

        <h2 id="publication">Review, embargo and publication</h2>
        <ol>
          <li>
            A compiler presses <strong>Submit for review</strong>.
          </li>
          <li>
            A <em>different</em> person with the reviewer or admin role records
            a decision — approve, or request changes — and{' '}
            <strong>must write a note</strong>. An approval with no reasoning
            is refused by the database, not merely discouraged.
          </li>
          <li>
            Approval <strong>freezes the vintage</strong> the run read. From
            then on those observations cannot change. A correction is a new
            vintage and a new run.
          </li>
          <li>
            An admin <strong>publishes</strong>, optionally with an{' '}
            <strong>embargo</strong> timestamp, which must be in the future.
          </li>
        </ol>
        <p>
          Exports carry the embargo stamp. Two formats are available from the
          run page: <strong>SDMX-CSV</strong> for exchange with international
          bodies, and <strong>Excel</strong> for everything else. Both state a
          unit on every row, because a published extract that does not say
          whether a figure is in millions or per head is a figure waiting to be
          misread.
        </p>

        <h2 id="audit">The audit trail</h2>
        <p>
          <strong>Audit trail</strong> in the section nav. Every change to
          tenant data — who, when, which row, the values before and after, and
          the reason recorded at the time.
        </p>
        <p>
          It is append-only, enforced by a database trigger: no one can edit or
          delete an entry, including through a privileged connection. Filters
          are links rather than form state, so a filtered view can be pasted
          into a report and returned to later.
        </p>

        <h2 id="refusals">When the platform refuses to compile</h2>
        <p>
          A GDP total assembled from an incomplete account is not
          approximately right — it is wrong in a way that looks entirely
          plausible in a published table. So rather than compile short, the
          platform withholds the affected approach and says why. The common
          cases:
        </p>
        <ul>
          <li>
            <strong>A required component is missing.</strong> No P.7 means no
            expenditure GDP. No D.21 means no production GDP, because value
            added at basic prices cannot become GDP at market prices without
            it.
          </li>
          <li>
            <strong>Output is at producers&apos; prices.</strong> Converting to
            basic prices needs the embedded tax and subsidy amounts, which you
            have and the engine does not. Convert before uploading.
          </li>
          <li>
            <strong>Units are mixed.</strong> Reported, never summed.
          </li>
          <li>
            <strong>Consumption names no sector</strong> and no code that
            identifies one. See <a href="#sectors">Institutional sectors</a>.
          </li>
          <li>
            <strong>An adjustment is half-specified.</strong> See{' '}
            <a href="#adjustments">FISIM and imputed rent</a>.
          </li>
        </ul>
        <p>
          Genuinely optional components are the exception and are treated as
          zero with a note: NPISH consumption (several countries fold it into
          households), changes in inventories, and valuables.
        </p>

        <h2 id="messages">What the messages mean</h2>
        <h3>While validating an upload</h3>
        <Panel scroll>
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">unknown_period</td>
                <td>
                  Define the reference period first, or correct the label in
                  the file.
                </td>
              </tr>
              <tr>
                <td className="mono">unknown_transaction_code</td>
                <td>
                  Check the code against <a href="#codes">the table above</a>.
                </td>
              </tr>
              <tr>
                <td className="mono">unknown_classification_code</td>
                <td>
                  The code did not resolve against the classification version
                  you chose. Usually the wrong version, or no version chosen at
                  all.
                </td>
              </tr>
              <tr>
                <td className="mono">duplicate_coordinate</td>
                <td>
                  Two rows claim the same series and period. One of them is
                  wrong, or they need summing before upload.
                </td>
              </tr>
              <tr>
                <td className="mono">coverage_gap</td>
                <td>
                  A series is present in some periods and absent in others.
                  Often legitimate; check it is not a missing extract.
                </td>
              </tr>
              <tr>
                <td className="mono">suspicious_magnitude_jump</td>
                <td>
                  A value moved far more than its neighbours. Frequently a unit
                  error in the source.
                </td>
              </tr>
              <tr>
                <td className="mono">value_added_exceeds_output</td>
                <td>
                  Intermediate consumption is negative, or P.1 and P.2 are the
                  wrong way round.
                </td>
              </tr>
              <tr>
                <td className="mono">ambiguous_decimal_separator</td>
                <td>
                  The file could be read two ways. Set the separator explicitly
                  in the mapping.
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <h3>After compiling</h3>
        <Panel scroll>
          <table>
            <thead>
              <tr>
                <th>Message</th>
                <th>What it means</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">approaches_diverge</td>
                <td>
                  Two approaches differ by more than 1% of the headline. This
                  is information, not an error — but a large gap between
                  independently sourced approaches is the most informative
                  signal in a compilation, and worth understanding before
                  publishing.
                </td>
              </tr>
              <tr>
                <td className="mono">negative_value_added</td>
                <td>
                  Possible and occasionally genuine, far more often a mapping
                  or sign error.
                </td>
              </tr>
              <tr>
                <td className="mono">fisim_allocation_mismatch</td>
                <td>
                  The FISIM allocations do not sum to FISIM output. See{' '}
                  <a href="#adjustments">FISIM and imputed rent</a>.
                </td>
              </tr>
              <tr>
                <td className="mono">imputed_rent_not_in_expenditure</td>
                <td>
                  Imputed rent is in production but household consumption
                  excludes it — or you have not said either way. The two sides
                  will differ by exactly that amount.
                </td>
              </tr>
              <tr>
                <td className="mono">sector_value_added_incomplete</td>
                <td>
                  Some producers carry no institutional sector, so the sector
                  breakdown covers only part of the economy. See{' '}
                  <a href="#sector-value-added">Value added by sector</a>.
                </td>
              </tr>
              <tr>
                <td className="mono">component_missing</td>
                <td>
                  FISIM was allocated to an industry that is not in the
                  compilation, or a figure that should be positive arrived
                  already negated.
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>

        <h2 id="limits">Known limitations</h2>
        <p>
          Stated plainly, because an NSO needs to know what it is relying on:
        </p>
        <ul>
          <li>
            <strong>The classification seeds are transcribed, not downloaded.</strong>{' '}
            ISIC, CPC, COICOP, COFOG and the institutional sectors were entered
            by hand from the published structures, and are marked unverified in
            the data itself. Load the official files and verify them before
            relying on the code lists for a statutory release.
          </li>
          <li>
            <strong>
              The engine has not been checked against published national
              accounts.
            </strong>{' '}
            It is internally consistent and extensively tested against worked
            examples, but it has not yet been reconciled figure-for-figure with
            a real country&apos;s official accounts.
          </li>
          <li>
            <strong>The SDMX-CSV output has not been through a validator.</strong>{' '}
            It follows the specification as written; it has not been confirmed
            against an official conformance tool.
          </li>
          <li>
            <strong>The sector accounts proper are not implemented.</strong>{' '}
            Value added by institutional sector is compiled; the full sequence
            of accounts by sector — allocation of primary income, secondary
            distribution, saving and net lending — is not.
          </li>
        </ul>

        <hr />
        <p className="muted">
          Questions this guide does not answer are worth telling us about — a
          question asked twice is documentation that has not been written yet.
        </p>
        <p>
          <Link href="/orgs">Back to your organizations</Link>
        </p>
      </main>
    </>
  );
}

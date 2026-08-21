#!/usr/bin/env python3
"""Build the interface preview page from the application's own stylesheet.

The preview shows every screen of the platform filled with representative
data. It is generated rather than hand-written so it cannot drift from
`src/app/globals.css`: the stylesheet is read at build time and re-scoped
under `.app`, and the markup below mirrors the real page components.

    python3 scripts/build-preview.py <output.html>
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / 'src' / 'app' / 'globals.css'


# --- Scoping the application stylesheet -------------------------------------
# Each frame is a div, not a document, so document-level selectors have to be
# rewritten onto `.app` and everything else nested inside it. The dark tokens
# are taken from the explicit `[data-theme='dark']` block; the
# prefers-color-scheme block is dropped, because in the preview the theme is
# chosen by the toggle rather than by the reader's OS.

def scope_selector(selector: str) -> str | None:
    out = []
    for part in (p.strip() for p in selector.split(',')):
        if not part:
            continue
        if part == ':root' or part in ('html', 'body'):
            out.append('.app')
        elif part.startswith(':root:not'):
            return None  # the prefers-color-scheme duplicate
        elif part.startswith(':root['):
            out.append('.app' + part[len(':root'):])
        elif part == '*':
            out.append('.app, .app *')
        else:
            out.append('.app ' + part)
    return ', '.join(out)


def scope_block(css: str) -> str:
    """Rewrite a run of top-level rules, recursing into at-rules."""
    out = []
    i = 0
    n = len(css)
    while i < n:
        # Comments and whitespace pass through untouched.
        if css.startswith('/*', i):
            end = css.index('*/', i) + 2
            out.append(css[i:end])
            i = end
            continue
        if css[i].isspace():
            out.append(css[i])
            i += 1
            continue

        brace = css.index('{', i)
        prelude = css[i:brace].strip()

        depth, j = 1, brace + 1
        while depth:
            if css[j] == '{':
                depth += 1
            elif css[j] == '}':
                depth -= 1
            j += 1
        body = css[brace + 1:j - 1]

        if prelude.startswith('@'):
            if 'prefers-color-scheme' in prelude:
                pass  # handled by the [data-theme] block instead
            else:
                out.append(prelude + ' {' + scope_block(body) + '}')
        else:
            scoped = scope_selector(prelude)
            if scoped:
                out.append(scoped + ' {' + body + '}')
        i = j
    return ''.join(out)


def scoped_app_css() -> str:
    css = CSS.read_text()
    # `main` centres itself in a 68rem column; inside a preview frame the
    # frame is the column, so let it fill.
    return scope_block(css)


# --- Screens ----------------------------------------------------------------

def bar(email='r.okonkwo@nso.example', org=None):
    right = ''
    if org:
        right += f'<span>{org}</span>'
    right += f'<span class="mono">{email}</span><button class="link" type="button">Sign out</button>'
    return f'''<div class="identity-bar"><div class="identity-inner">
      <a class="wordmark" href="#"><span class="mark">SNA</span><span>Compilation Platform</span></a>
      <div class="identity-right">{right}</div>
    </div></div>'''


def plain_bar():
    return '''<div class="identity-bar"><div class="identity-inner">
      <a class="wordmark" href="#"><span class="mark">SNA</span><span>Compilation Platform</span></a>
    </div></div>'''


def nav(current):
    items = [('Overview', 'overview'), ('Classifications', 'classifications'),
             ('Source data', 'data'), ('Compilation runs', 'runs'),
             ('Audit trail', 'audit')]
    links = ''
    for label, k in items:
        mark = ' aria-current="page"' if k == current else ''
        links += f'<a href="#"{mark}>{label}</a>'
    return f'<nav class="section-nav"><div class="section-nav-inner">{links}</div></nav>'


def org_shell(current, org='National Statistical Office of Atlantis'):
    return bar(org=org) + nav(current)


LANDING = plain_bar() + '''
<main class="narrow">
  <h1>Compile GDP under SNA 2008</h1>
  <p class="lede">Upload source data, map it to standard classifications, and
    compute Gross Domestic Product by the production, expenditure and income
    approaches — with a full audit trail and reproducible vintages.</p>
  <div class="actions">
    <button type="button">Sign in</button>
    <a href="#">Create an account</a>
  </div>
  <h3>What the platform guarantees</h3>
  <div class="panel"><div class="panel-body">
    <p class="muted"><strong>Reproducible.</strong> Every published figure is
      re-computable from a frozen vintage of source data plus the exact engine
      version and configuration that produced it.</p>
    <p class="muted"><strong>Auditable.</strong> Every change records who made
      it, when, what changed and why. Writes without a stated reason are
      refused.</p>
    <p class="muted"><strong>Isolated.</strong> Pre-release estimates are
      market-sensitive. Tenant separation is enforced in the database, not only
      in application code.</p>
  </div></div>
</main>'''


SIGNIN = plain_bar() + '''
<main class="narrow">
  <h1>Sign in</h1>
  <form class="stack">
    <label>Email<input type="email" value="r.okonkwo@nso.example" readonly></label>
    <label>Password<input type="password" value="000000000000" readonly></label>
    <button type="button">Sign in</button>
  </form>
  <p class="muted">No account? <a href="#">Create one</a>.</p>
</main>'''


ORGS = bar() + '''
<main>
  <h1>Your organizations</h1>
  <section class="panel">
    <div class="panel-head"><h3>Organizations</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Organization</th><th>Identifier</th></tr></thead>
      <tbody>
        <tr><td><a href="#">National Statistical Office of Atlantis</a></td><td class="mono muted">nso-atlantis</td></tr>
        <tr><td><a href="#">Borduria Regional Accounts Unit</a></td><td class="mono muted">borduria-regional</td></tr>
      </tbody>
    </table></div>
  </section>
  <h2>Create an organization</h2>
  <form class="stack">
    <label>Name<input value="" readonly></label>
    <label>Identifier used in URLs<input placeholder="nso-atlantis" readonly></label>
    <button type="button">Create organization</button>
  </form>
  <p class="muted">You become the organization's admin.</p>
</main>'''


ORG = org_shell('overview') + '''
<main>
  <h1>National Statistical Office of Atlantis</h1>
  <ul class="meta">
    <li><span class="k">Identifier</span><span class="v mono">nso-atlantis</span></li>
    <li><span class="k">Fiscal year starts</span><span class="v">month 7</span></li>
    <li><span class="k">Your role</span><span class="v">admin</span></li>
  </ul>
  <section class="panel">
    <div class="panel-head"><h3>Members · 4</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Email</th><th>Role</th><th>Can</th><th>Since</th></tr></thead>
      <tbody>
        <tr><td class="mono">r.okonkwo@nso.example</td><td><span class="pill is-accent">admin</span></td><td class="muted">manages members and publishes</td><td class="mono muted">2026-01-12</td></tr>
        <tr><td class="mono">j.halvorsen@nso.example</td><td><span class="pill">compiler</span></td><td class="muted">uploads data and runs compilations</td><td class="mono muted">2026-01-12</td></tr>
        <tr><td class="mono">a.pereira@nso.example</td><td><span class="pill is-positive">reviewer</span></td><td class="muted">approves runs for publication</td><td class="mono muted">2026-02-03</td></tr>
        <tr><td class="mono">treasury.liaison@gov.example</td><td><span class="pill">viewer</span></td><td class="muted">read-only</td><td class="mono muted">2026-04-21</td></tr>
      </tbody>
    </table></div>
  </section>
  <h2>Add a member</h2>
  <form class="stack">
    <label>Account email<input type="email" readonly></label>
    <label>Role<select><option>viewer — read-only</option></select></label>
    <button type="button">Add member</button>
  </form>
  <p class="muted">The person must already have an account with that email.</p>
</main>'''


CLASSIFICATIONS = org_shell('classifications') + '''
<main>
  <h1>Classifications</h1>
  <p class="lede">The standards every compilation is expressed in, and this
    organization's own national adaptations mapped onto them.</p>

  <div class="callout is-warning">
    <p class="callout-title">4 classifications awaiting verification</p>
    <p class="muted" style="margin:0">These were transcribed from the published
      structure and have not yet been diffed against the official file. Load the
      official file to verify them — until then, treat the codes as
      provisional.</p>
  </div>

  <section class="panel">
    <div class="panel-head"><h3>Standards</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Classification</th><th>Version</th><th class="num">Items</th><th>Depth</th><th>Provenance</th></tr></thead>
      <tbody>
        <tr><td><span class="mono">ISIC4</span><br><span class="muted">International Standard Industrial Classification, Rev.4</span></td><td class="mono">Rev.4</td><td class="num">109</td><td class="muted">to division</td><td><span class="pill is-warning">Awaiting verification</span></td></tr>
        <tr><td><span class="mono">CPC21</span><br><span class="muted">Central Product Classification, Ver.2.1</span></td><td class="mono">Ver.2.1</td><td class="num">80</td><td class="muted">to division</td><td><span class="pill is-warning">Awaiting verification</span></td></tr>
        <tr><td><span class="mono">COICOP</span><br><span class="muted">Classification of Individual Consumption by Purpose</span></td><td class="mono">2018</td><td class="num">13</td><td class="muted">to division</td><td><span class="pill is-warning">Awaiting verification</span></td></tr>
        <tr><td><span class="mono">COFOG</span><br><span class="muted">Classification of the Functions of Government</span></td><td class="mono">1999</td><td class="num">10</td><td class="muted">to division</td><td><span class="pill is-warning">Awaiting verification</span></td></tr>
        <tr><td><span class="mono">SECTOR</span><br><span class="muted">SNA 2008 institutional sectors</span></td><td class="mono">2008</td><td class="num">6</td><td class="muted">to level 1</td><td><span class="pill is-positive">Official file</span></td></tr>
      </tbody>
    </table></div>
  </section>
  <p class="muted">Depth is the deepest level present — a classification shown
    to division level does not contain groups or classes yet.</p>

  <h2>This organization's classifications</h2>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Classification</th><th>Version</th><th class="num">Items</th><th>Depth</th></tr></thead>
    <tbody>
      <tr><td><span class="mono">ATL-NACT</span><br><span class="muted">Atlantis national activity classification</span></td><td class="mono">2019</td><td class="num">64</td><td class="muted">to level 3</td></tr>
    </tbody>
  </table></div></section>

  <h2>Mappings</h2>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Mapping</th><th class="num">Entries</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>ATL-NACT 2019 → ISIC4 Rev.4</td><td class="num">64</td><td><span class="pill is-positive">Complete and exhaustive</span></td></tr>
      <tr><td>ATL-NACT 2019 → CPC21 Ver.2.1</td><td class="num">11</td><td><span class="pill is-warning">Draft</span></td></tr>
    </tbody>
  </table></div></section>
</main>'''


DATA = org_shell('data') + '''
<main>
  <h1>Source data</h1>
  <p class="lede">Uploaded surveys, administrative records and statistical
    extracts. Each file is stored with its checksum, so a committed figure
    always traces back to the exact bytes it came from.</p>

  <h2>Datasets</h2>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Name</th><th class="num">Rows</th><th>Status</th><th>Uploaded</th></tr></thead>
    <tbody>
      <tr><td><a href="#">Annual business survey 2024</a><br><span class="muted mono">abs-2024-annual.xlsx</span></td><td class="num">2,184</td><td><span class="pill is-positive">Committed</span></td><td class="mono muted">2026-03-14</td></tr>
      <tr><td><a href="#">Government finance statistics 2024</a><br><span class="muted mono">gfs-2024.csv</span></td><td class="num">418</td><td><span class="pill is-positive">Committed</span></td><td class="mono muted">2026-03-18</td></tr>
      <tr><td><a href="#">Merchandise trade 2024 Q1–Q4</a><br><span class="muted mono">trade-2024.csv</span></td><td class="num">1,096</td><td><span class="pill is-warning">Validated</span> <span class="pill is-critical">3 errors</span></td><td class="mono muted">2026-03-22</td></tr>
      <tr><td><a href="#">Household budget survey 2024</a><br><span class="muted mono">hbs-2024.xlsx</span></td><td class="num">—</td><td><span class="pill">Uploaded</span></td><td class="mono muted">2026-03-25</td></tr>
    </tbody>
  </table></div></section>

  <h2>Upload a file</h2>
  <form class="stack">
    <label>File — .csv or .xlsx, up to 10 MB<input type="file" disabled></label>
    <label>Name<input placeholder="Annual business survey 2024" readonly></label>
    <label>Provenance — where this came from<input placeholder="ABS extract, run 2026-03-14" readonly></label>
    <button type="button">Upload</button>
  </form>
</main>'''


DATASET = org_shell('data') + '''
<main>
  <a class="backlink" href="#">← Source data</a>
  <h1>Merchandise trade 2024 Q1–Q4</h1>
  <ul class="meta">
    <li><span class="v mono">trade-2024.csv</span></li>
    <li><span class="k">Rows</span><span class="v">1096</span></li>
    <li><span class="k">Size</span><span class="v">184.6 KB</span></li>
    <li><span class="k">SHA-256</span><span class="v mono">9f2c41a7be03d5e8…</span></li>
    <li><span class="k">Provenance</span><span class="v">Customs authority extract, run 2026-03-22</span></li>
  </ul>

  <ol class="stepper">
    <li class="is-done"><span class="n">1</span> Uploaded</li>
    <li class="is-done"><span class="n">2</span> Mapped</li>
    <li class="is-current"><span class="n">3</span> Validated</li>
    <li><span class="n">4</span> Committed</li>
  </ol>

  <h2>Map the columns</h2>
  <form class="stack wide">
    <label>Value *<select><option>value_nc_mn</option></select></label>
    <label>Reference period *<select><option>period</option></select></label>
    <label>SNA transaction code<select><option>txn</option></select></label>
    <label>Activity code<select><option>— not mapped —</option></select></label>
    <label>Institutional sector code<select><option>sector</option></select></label>
    <label>Unit (per row, optional)<select><option>— not mapped —</option></select></label>
    <label>…or one transaction code for every row<input placeholder="P.1" readonly></label>
    <label>Activity classification version<select><option>ISIC4 Rev.4</option></select></label>
    <label>Institutional sector classification version<select><option>SNA_SECTOR 2008</option></select></label>
    <label>Unit for the whole file<select><option>NC_MN — millions of national currency</option></select></label>
    <label>Frequency<select><option>quarterly</option></select></label>
    <label>Valuation<select><option>purchasers' prices</option></select></label>
    <label>Decimal separator<select><option>— infer, and flag anything ambiguous —</option></select></label>
    <label>Save this mapping as<input placeholder="Customs quarterly extract" readonly></label>
    <button type="button">Apply mapping and validate</button>
  </form>

  <h2>Validation</h2>
  <ul class="meta">
    <li><span class="k">Ready to commit</span><span class="v">1,081 of 1,096 rows</span></li>
    <li><span class="pill is-critical">3 errors blocking</span></li>
    <li><span class="pill is-warning">12 warnings</span></li>
  </ul>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Finding</th><th class="num">Rows</th><th class="num">First</th></tr></thead>
    <tbody>
      <tr class="sev-error"><td><span class="mono">UNKNOWN_PERIOD</span> <span class="pill is-critical">error</span><br><span class="muted">Period label "2024-Q5" matches no reference period defined for this organization.</span></td><td class="num">3</td><td class="num">742</td></tr>
      <tr class="sev-warning"><td><span class="mono">AMBIGUOUS_DECIMAL</span> <span class="pill is-warning">warning</span><br><span class="muted">Value "1,240" could be one thousand two hundred and forty or one point two four. Set the decimal separator explicitly to remove the doubt.</span></td><td class="num">9</td><td class="num">18</td></tr>
      <tr class="sev-warning"><td><span class="mono">NEGATIVE_OUTPUT</span> <span class="pill is-warning">warning</span><br><span class="muted">P.6 exports recorded as negative. Legitimate for changes in inventories, unusual here.</span></td><td class="num">3</td><td class="num">301</td></tr>
      <tr class="sev-info"><td><span class="mono">COVERAGE_GAP</span> <span class="pill">info</span><br><span class="muted">No P.7 imports rows for 2024-Q3. The compilation will treat the quarter as incomplete.</span></td><td class="num">1</td><td class="num">—</td></tr>
    </tbody>
  </table></div></section>
  <p class="muted">Errors block the commit. Warnings do not — several of them
    are legitimately possible, and a compiler who has checked should not be
    stopped by the tool.</p>

  <h2>Commit</h2>
  <form class="stack">
    <label>Vintage<input value="2024 first estimate" readonly></label>
    <button type="button" disabled>Commit staged rows</button>
  </form>
  <p class="muted">Committing writes observations into an open vintage. Once a
    vintage is frozen its observations become immutable — revisions go into a
    new vintage, so a published figure stays reproducible.</p>
</main>'''


RUNS = org_shell('runs') + '''
<main>
  <h1>Compilation runs</h1>
  <p class="lede">A run is a named exercise — “2024 Annual Estimates, first
    release”. It pins the vintage it reads and the engine version that computed
    it, so every figure it produces can be re-derived.</p>

  <h2>Runs</h2>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Run</th><th>Input vintage</th><th>Anchor</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td><a href="#">2024 Annual Estimates, first release</a><br><span class="muted mono">executed 2026-04-02 09:14</span></td><td>2024 first estimate <span class="pill">frozen</span></td><td class="mono muted">production</td><td><span class="pill is-positive">published</span></td></tr>
      <tr><td><a href="#">2024 Annual Estimates, revision 1</a><br><span class="muted mono">executed 2026-08-11 16:40</span></td><td>2024 revised</td><td class="mono muted">production</td><td><span class="pill is-warning">under review</span></td></tr>
      <tr><td><a href="#">2023 back series, chain-linked</a><br><span class="muted mono">executed 2026-02-27 11:02</span></td><td>2023 final <span class="pill">frozen</span></td><td class="mono muted">expenditure</td><td><span class="pill">computed</span></td></tr>
    </tbody>
  </table></div></section>

  <h2>New run</h2>
  <form class="stack wide">
    <label>Name<input placeholder="2024 Annual Estimates, first release" readonly></label>
    <label>Input vintage<select><option>2024 revised — 3,617 observations</option></select></label>
    <label>Balancing anchor<select><option>production</option></select></label>
    <label>Frequency<select><option>annual</option></select></label>
    <label>Volume reference period (optional)<input value="2021" readonly></label>
    <label>Index formula<select><option>Laspeyres</option></select></label>
    <label>FISIM treatment<select><option>allocated — SNA 2008: producers&#39; share is intermediate</option></select></label>
    <label>Household consumption includes imputed rent<select><option>yes — it is already in P.31</option></select></label>
    <button type="button">Create run</button>
  </form>
</main>'''


RUN = org_shell('runs') + '''
<main>
  <a class="backlink" href="#">← Compilation runs</a>
  <h1>2024 Annual Estimates, revision 1</h1>
  <ul class="meta">
    <li><span class="k">Vintage</span><span class="v">2024 revised</span></li>
    <li><span class="k">Anchor</span><span class="v">production</span></li>
    <li><span class="k">FISIM</span><span class="v">allocated</span></li>
    <li><span class="k">Imputed rent in P.31</span><span class="v">yes</span></li>
    <li><span class="k">Engine</span><span class="v mono">0.1.0</span></li>
    <li><span class="k">Executed</span><span class="v mono">2026-08-11 16:40</span></li>
  </ul>

  <ol class="stepper">
    <li class="is-done"><span class="n">1</span> Computed</li>
    <li class="is-current"><span class="n">2</span> Under review</li>
    <li><span class="n">3</span> Approved</li>
    <li><span class="n">4</span> Published</li>
  </ol>

  <div class="actions">
    <button type="button" class="secondary">Re-execute</button>
    <a href="#">Export SDMX-CSV</a>
    <a href="#">Export Excel</a>
  </div>

  <section class="panel">
    <div class="panel-head"><h3>GDP at market prices, by approach</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Period</th><th class="num">Production</th><th class="num">Expenditure</th><th class="num">Income</th><th class="num">Headline</th></tr></thead>
      <tbody>
        <tr><td class="mono">2021</td><td class="num">184,220.00</td><td class="num">183,905.40</td><td class="num">184,061.10</td><td class="num strong">184,220.00</td></tr>
        <tr><td class="mono">2022</td><td class="num">198,744.60</td><td class="num">198,301.20</td><td class="num">198,590.80</td><td class="num strong">198,744.60</td></tr>
        <tr><td class="mono">2023</td><td class="num">210,118.35</td><td class="num">209,880.90</td><td class="num">210,402.15</td><td class="num strong">210,118.35</td></tr>
        <tr><td class="mono">2024</td><td class="num">221,540.70</td><td class="num">221,109.05</td><td class="num">221,733.20</td><td class="num strong">221,540.70</td></tr>
      </tbody>
    </table></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h3>Statistical discrepancy</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Period</th><th class="num">Production</th><th class="num">Expenditure</th><th class="num">Income</th></tr></thead>
      <tbody>
        <tr><td class="mono">2021</td><td class="num">0.00</td><td class="num">314.60</td><td class="num">158.90</td></tr>
        <tr><td class="mono">2022</td><td class="num">0.00</td><td class="num">443.40</td><td class="num">153.80</td></tr>
        <tr><td class="mono">2023</td><td class="num">0.00</td><td class="num">237.45</td><td class="num is-negative">−283.80</td></tr>
        <tr><td class="mono">2024</td><td class="num">0.00</td><td class="num">431.65</td><td class="num is-negative">−192.50</td></tr>
      </tbody>
    </table></div>
  </section>
  <p class="muted">Anchor minus the approach, so a positive figure means that
    approach falls short of the headline. Discrepancies are reported, never
    removed by adjusting an estimate.</p>

  <section class="panel">
    <div class="panel-head"><h3>Components · 2024</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Approach</th><th>Component</th><th class="num">Value</th><th></th></tr></thead>
      <tbody>
        <tr><td>production</td><td>&#931; gross value added</td><td class="num">115,747.75</td><td><a href="#">sources</a></td></tr>
        <tr><td>production</td><td>Taxes on products</td><td class="num">14,208.30</td><td><a href="#">sources</a></td></tr>
        <tr><td>production</td><td>Subsidies on products</td><td class="num">2,914.60</td><td><a href="#">sources</a></td></tr>
        <tr><td>expenditure</td><td>Final consumption expenditure</td><td class="num">84,119.05</td><td><a href="#">sources</a></td></tr>
        <tr><td>expenditure</td><td>Gross capital formation</td><td class="num">31,660.40</td><td><a href="#">sources</a></td></tr>
        <tr><td>expenditure</td><td>Net exports</td><td class="num is-negative">&#8722;8,738.00</td><td><a href="#">sources</a></td></tr>
        <tr><td>income</td><td>Factor incomes</td><td class="num">114,336.20</td><td><a href="#">sources</a></td></tr>
        <tr><td>income</td><td>Net taxes on production and imports</td><td class="num">12,705.25</td><td><a href="#">sources</a></td></tr>
      </tbody>
    </table></div>
  </section>

  <h2>Value added by industry</h2>
  <section class="panel">
    <div class="panel-head"><h3>2024 · current prices</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Industry</th><th class="num">Output</th><th class="num">Intermediate</th><th class="num">Value added</th><th></th></tr></thead>
      <tbody>
        <tr><td><span class="mono">A</span> Agriculture, forestry and fishing</td><td class="num">18,402.10</td><td class="num">9,118.60</td><td class="num strong">9,283.50</td><td><a href="#">sources</a></td></tr>
        <tr><td><span class="mono">B</span> Mining and quarrying</td><td class="num">7,940.00</td><td class="num">3,015.20</td><td class="num strong">4,924.80</td><td><a href="#">sources</a></td></tr>
        <tr><td><span class="mono">C</span> Manufacturing</td><td class="num">88,617.40</td><td class="num">54,902.15</td><td class="num strong">33,715.25</td><td><a href="#">sources</a></td></tr>
        <tr><td><span class="mono">F</span> Construction</td><td class="num">31,204.80</td><td class="num">18,660.05</td><td class="num strong">12,544.75</td><td><a href="#">sources</a></td></tr>
        <tr><td><span class="mono">G</span> Wholesale and retail trade</td><td class="num">44,081.90</td><td class="num">20,776.40</td><td class="num strong">23,305.50</td><td><a href="#">sources</a></td></tr>
        <tr><td><span class="mono">K</span> Financial and insurance activities</td><td class="num">21,338.00</td><td class="num">12,905.70</td><td class="num strong">8,432.30</td><td><a href="#">sources</a></td></tr>
        <tr><td><span class="mono">L</span> Real estate activities</td><td class="num">27,660.55</td><td class="num">4,118.90</td><td class="num strong">23,541.65</td><td><a href="#">sources</a></td></tr>
      </tbody>
    </table></div>
  </section>

  <h2>Source records &#8212; Final consumption expenditure &#183; 2024</h2>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Transaction</th><th>Industry</th><th>Sector</th><th class="num">Value</th><th>Source file</th><th class="num">Row</th><th>As uploaded</th></tr></thead>
    <tbody>
      <tr><td class="mono">P.31</td><td class="mono">&#8212;</td><td class="mono">S.14</td><td class="num">71,455.30</td><td>hbs-2024.xlsx<br><span class="muted mono">3f9a1c7e08b2…</span></td><td class="num">417</td><td class="muted mono">{"txn":"P.31","sector":"S.14","period":"2024","value_nc_mn":"71455.3"}</td></tr>
      <tr><td class="mono">P.31</td><td class="mono">&#8212;</td><td class="mono">S.15</td><td class="num">1,902.40</td><td>hbs-2024.xlsx<br><span class="muted mono">3f9a1c7e08b2…</span></td><td class="num">418</td><td class="muted mono">{"txn":"P.31","sector":"S.15","period":"2024","value_nc_mn":"1902.4"}</td></tr>
      <tr><td class="mono">P.3</td><td class="mono">&#8212;</td><td class="mono">S.13</td><td class="num">10,761.35</td><td>gfs-2024.csv<br><span class="muted mono">b17c40e9d551…</span></td><td class="num">92</td><td class="muted mono">{"txn":"P.3","sector":"S.13","period":"2024","value_nc_mn":"10761.35"}</td></tr>
    </tbody>
  </table></div></section>
  <p><a href="#">Close drill-down</a></p>

  <h2>Chain-linked volume measures</h2>
  <ul class="meta">
    <li><span class="k">Reference period</span><span class="v mono">2021</span></li>
    <li><span class="k">Index</span><span class="v">laspeyres</span></li>
  </ul>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Period</th><th class="num">Chain index</th><th class="num">Volume</th><th class="num">Growth %</th><th class="num">Sum of industries</th><th class="num">Residual</th></tr></thead>
    <tbody>
      <tr><td class="mono">2021</td><td class="num">100.00</td><td class="num">184,220.00</td><td class="num">—</td><td class="num">184,220.00</td><td class="num">0.00</td></tr>
      <tr><td class="mono">2022</td><td class="num">103.41</td><td class="num">190,502.88</td><td class="num">3.41</td><td class="num">190,502.88</td><td class="num">0.00</td></tr>
      <tr><td class="mono">2023</td><td class="num">105.87</td><td class="num">195,033.71</td><td class="num">2.38</td><td class="num">195,102.44</td><td class="num is-negative">−68.73</td></tr>
      <tr><td class="mono">2024</td><td class="num">108.62</td><td class="num">200,100.96</td><td class="num">2.60</td><td class="num">200,285.30</td><td class="num is-negative">−184.34</td></tr>
    </tbody>
  </table></div></section>

  <div class="callout is-note">
    <p class="callout-title">Why the industries do not add up to the total</p>
    <p>The <strong>Residual</strong> column is not an error and not a rounding
      artefact. Chain-linked volumes are <em>not additive</em>, and cannot be
      made additive without misstating the components.</p>
    <p class="muted">Each series is revalued at its own previous period's prices
      before being linked, so every series carries a different set of price
      weights. Adding series with different weights does not give the aggregate,
      which carries the weights of the whole economy. The parts do add up in the
      reference period, and in the period immediately after it, and then diverge
      — which is why the residual starts at zero and grows.</p>
    <p class="muted" style="margin-bottom:0">SNA 2008 chapter 15 treats this as
      a property of the measure, and publishing the residual is standard
      practice among national statistical offices. Forcing the components to sum
      would change each industry's published volume to preserve an arithmetic
      property the measure does not have. Current-price figures <em>are</em>
      additive.</p>
  </div>

  <h2>Review and publication</h2>
  <div class="callout is-critical">
    <p class="callout-title">Embargoed until 2026-09-30 09:30</p>
    <p class="muted" style="margin-bottom:0">Members of this organization can
      see these figures — compiling them is the job. The embargo governs release
      to anyone else, and every export is stamped until it lifts.</p>
  </div>

  <section class="panel"><div class="panel-body">
    <ul class="meta" style="margin-bottom:0.75rem">
      <li><span class="k">Status</span><span class="v">under review</span></li>
    </ul>
    <form class="stack">
      <label>Decision<select><option>Approve — freezes the input vintage</option><option>Request changes</option></select></label>
      <label>Note<input placeholder="What you checked, and what you concluded" readonly></label>
      <button type="button">Record decision</button>
    </form>
  </div></section>

  <section class="panel">
    <div class="panel-head"><h3>Review history</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Decision</th><th>Reviewer</th><th>When</th><th>Note</th></tr></thead>
      <tbody>
        <tr><td><span class="pill is-warning">changes requested</span></td><td class="mono">a.pereira@nso.example</td><td class="mono muted">2026-08-09</td><td>Construction output looks to double-count the Q2 infrastructure programme. Re-check against the GFS extract before resubmitting.</td></tr>
      </tbody>
    </table></div>
  </section>
  <p class="muted">Exports carry the run's provenance: input vintage, freeze
    time, pinned engine version and method configuration, and the SHA-256 of
    every source file behind the figures. Both formats are stamped EMBARGOED
    until the release time.</p>

  <h2>Diagnostics</h2>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Finding</th><th>Period</th></tr></thead>
    <tbody>
      <tr class="sev-warning"><td><span class="mono">DISCREPANCY_LARGE</span> <span class="pill is-warning">warning</span> <span class="muted">· expenditure</span><br><span class="muted">Statistical discrepancy is 0.19% of the anchor, above the 0.15% threshold configured for this run.</span></td><td class="mono muted">2024</td></tr>
      <tr class="sev-info"><td><span class="mono">FISIM_UNALLOCATED</span> <span class="pill">info</span><br><span class="muted">FISIM was not allocated to user industries; it is recorded as intermediate consumption of a notional industry, which is the SNA 2008 fallback treatment.</span></td><td class="mono muted">2024</td></tr>
      <tr class="sev-info"><td><span class="mono">COVERAGE_GAP</span> <span class="pill">info</span><br><span class="muted">No observations for ISIC section T (activities of households as employers). Value added is treated as zero, not missing.</span></td><td class="mono muted">2024</td></tr>
    </tbody>
  </table></div></section>
</main>'''


QUARTERLY = org_shell('runs') + """
<main>
  <a class="backlink" href="#">← Compilation runs</a>
  <h1>2025 Q1–Q4, third estimate</h1>
  <ul class="meta">
    <li><span class="k">Vintage</span><span class="v">2025 quarterly</span></li>
    <li><span class="k">Frequency</span><span class="v">quarterly</span></li>
    <li><span class="k">Anchor</span><span class="v">production</span></li>
    <li><span class="k">Benchmark</span><span class="v">2024 Annual Estimates, revision 1 · Denton proportional</span></li>
    <li><span class="k">Engine</span><span class="v mono">0.1.0</span></li>
  </ul>

  <ol class="stepper">
    <li class="is-done"><span class="n">1</span> Computed</li>
    <li class="is-current"><span class="n">2</span> Under review</li>
    <li><span class="n">3</span> Approved</li>
    <li><span class="n">4</span> Published</li>
  </ol>

  <h2>Quarterly path</h2>
  <section class="panel">
    <div class="panel-head"><h3>Headline GDP — indicator and benchmarked</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Quarter</th><th class="num">Indicator</th><th class="num">Benchmarked</th><th class="num">Ratio</th><th class="num">Q/Q %</th><th class="num">Y/Y %</th></tr></thead>
      <tbody>
        <tr><td class="mono">2024-Q1</td><td class="num">53,180.40</td><td class="num strong">54,022.85</td><td class="num">1.0158</td><td class="num">—</td><td class="num">—</td></tr>
        <tr><td class="mono">2024-Q2</td><td class="num">54,905.10</td><td class="num strong">55,780.02</td><td class="num">1.0159</td><td class="num">3.25</td><td class="num">—</td></tr>
        <tr><td class="mono">2024-Q3</td><td class="num">56,402.75</td><td class="num strong">57,318.44</td><td class="num">1.0162</td><td class="num">2.76</td><td class="num">—</td></tr>
        <tr><td class="mono">2024-Q4</td><td class="num">54,118.90</td><td class="num strong">55,019.39</td><td class="num">1.0166</td><td class="num is-negative">−4.01</td><td class="num">—</td></tr>
        <tr><td class="mono">2025-Q1</td><td class="num">55,040.20</td><td class="num strong">55,976.10</td><td class="num">1.0170</td><td class="num">1.74</td><td class="num">3.62</td></tr>
        <tr><td class="mono">2025-Q2</td><td class="num">56,881.65</td><td class="num strong">57,848.63</td><td class="num">1.0170</td><td class="num">3.34</td><td class="num">3.71</td></tr>
        <tr><td class="mono">2025-Q3</td><td class="num">58,204.30</td><td class="num strong">59,193.77</td><td class="num">1.0170</td><td class="num">2.32</td><td class="num">3.27</td></tr>
        <tr><td class="mono">2025-Q4</td><td class="num">55,918.05</td><td class="num strong">56,868.66</td><td class="num">1.0170</td><td class="num is-negative">−3.93</td><td class="num">3.36</td></tr>
      </tbody>
    </table></div>
  </section>
  <p class="muted">Growth rates are computed on the published figure — the
    benchmarked one where the run is benchmarked. These series are
    <strong>not seasonally adjusted</strong>: quarter-on-quarter movements
    therefore carry the seasonal pattern as well as the underlying change,
    which is why the year-on-year column is the one usually quoted.</p>

  <section class="panel">
    <div class="panel-head"><h3>Reconciliation to the annual accounts</h3></div>
    <div class="panel-scroll"><table>
      <thead><tr><th>Year</th><th>Series</th><th class="num">Annual total</th><th class="num">Indicator sum</th><th class="num">Benchmarked sum</th><th class="num">Residual</th></tr></thead>
      <tbody>
        <tr><td class="mono">2024</td><td class="muted">summary · headline gdp</td><td class="num">222,140.70</td><td class="num">218,607.15</td><td class="num strong">222,140.70</td><td class="num">0.00</td></tr>
        <tr><td class="mono">2024</td><td class="muted">production · gdp</td><td class="num">222,140.70</td><td class="num">218,607.15</td><td class="num strong">222,140.70</td><td class="num">0.00</td></tr>
        <tr><td class="mono">2024</td><td class="muted">production · total gross value added</td><td class="num">198,402.55</td><td class="num">195,188.40</td><td class="num strong">198,402.55</td><td class="num">0.00</td></tr>
      </tbody>
    </table></div>
  </section>
  <p class="muted">The residual column is the check, not a finding: it is zero
    because the constraint was imposed. It is stored and shown so an auditor
    can confirm that rather than take the method's word for it.</p>

  <div class="callout is-note">
    <p class="callout-title">What benchmarking changed, and what it did not</p>
    <p>The quarters now sum exactly to the annual accounts, because the annual
      figures come from better sources — censuses, audited government accounts,
      full-year tax records — than any quarterly indicator does. What survives
      from the indicator is its <em>movement</em>.</p>
    <p class="muted">Denton finds the adjustment that meets every annual total
      while changing as little as possible from one quarter to the next. The
      naive alternative — prorating each year separately — also meets the
      totals, but applies one adjustment across a year and a different one
      across the next, putting a step in the published growth rate at every
      turn of the year that nothing in the economy caused.</p>
    <p class="muted" style="margin-bottom:0">Quarters after the last
      benchmarked year carry the final adjustment forward unchanged. They are
      estimates against an annual total that does not exist yet, and will be
      revised when it does — which is normal for quarterly accounts, not a
      defect in these figures.</p>
  </div>

  <h2>Diagnostics</h2>
  <section class="panel"><div class="panel-scroll"><table>
    <thead><tr><th>Finding</th><th>Period</th></tr></thead>
    <tbody>
      <tr class="sev-info"><td><span class="mono">benchmark_extrapolated</span> <span class="pill">info</span> <span class="muted">· benchmarking</span><br><span class="muted">2025-Q1, 2025-Q2, 2025-Q3, 2025-Q4 fall after the last benchmarked year. Their figures carry the final benchmark-to-indicator adjustment forward unchanged, so they will be revised when the annual accounts for those years are compiled.</span></td><td class="mono muted">—</td></tr>
      <tr class="sev-warning"><td><span class="mono">benchmark_sign_change</span> <span class="pill is-warning">warning</span> <span class="muted">· expenditure gross capital formation</span><br><span class="muted">expenditure gross_capital_formation changes sign across the quarters, and proportional Denton adjusts by a ratio — which inverts where the series is negative and is unstable where it is near zero. Re-run with the additive variant if this series matters.</span></td><td class="mono muted">—</td></tr>
      <tr class="sev-info"><td><span class="mono">benchmark_components_not_additive</span> <span class="pill">info</span> <span class="muted">· benchmarking</span><br><span class="muted">Benchmarked industries do not sum exactly to benchmarked total value added — the largest gap is 41.28 in 2025-Q3, 0.021% of the total. Each series was smoothed against its own annual constraint, so the quarters add correctly down the year but the industries need not add across a quarter.</span></td><td class="mono muted">—</td></tr>
    </tbody>
  </table></div></section>
</main>"""


AUDIT = org_shell('audit') + """
<main>
  <h1>Audit trail</h1>
  <p class="lede">Every change to this organization's data: who made it, when,
    what it was before, what it became, and the reason recorded at the time.</p>

  <ul class="meta">
    <li><span class="k">Entries</span><span class="v">4,182</span></li>
    <li><span class="k">Showing</span><span class="v">100 most recent</span></li>
  </ul>

  <section class="panel">
    <div class="panel-head"><h3>Filter</h3></div>
    <div class="panel-body">
      <p class="filter-row"><span class="k">Table</span>
        <a href="#" aria-current="page">all</a>
        <a href="#">compilation run (28)</a>
        <a href="#">observation (3,904)</a>
        <a href="#">reference period (20)</a>
        <a href="#">review decision (6)</a>
        <a href="#">source file (14)</a>
        <a href="#">vintage (5)</a>
      </p>
      <p class="filter-row" style="margin-bottom:0"><span class="k">Who</span>
        <a href="#" aria-current="page">anyone</a>
        <a href="#">r.okonkwo@nso.example (91)</a>
        <a href="#">j.halvorsen@nso.example (4,068)</a>
        <a href="#">a.pereira@nso.example (23)</a>
      </p>
    </div>
  </section>

  <section class="panel"><div class="panel-scroll"><table class="audit">
    <thead><tr><th>When</th><th>Who</th><th>What</th><th>Change</th><th>Why</th></tr></thead>
    <tbody>
      <tr>
        <td class="mono muted">2026-08-20 16:41:02</td>
        <td class="mono">a.pereira@nso.example</td>
        <td><span class="pill is-positive">insert</span> review decision<br><span class="muted">changes_requested · Construction output looks to double-count the Q2 infrastructure programme. Re-check against the GFS extract before resubmitting.</span></td>
        <td><span class="muted">—</span></td>
        <td>review run "2024 Annual Estimates, revision 1": changes_requested</td>
      </tr>
      <tr>
        <td class="mono muted">2026-08-20 16:40:55</td>
        <td class="mono">j.halvorsen@nso.example</td>
        <td><span class="pill is-accent">update</span> compilation run<br><span class="muted">2024 Annual Estimates, revision 1 · under_review</span></td>
        <td><ul class="changes"><li><span class="mono">status</span> <span class="muted">computed</span> → <span class="strong">under_review</span></li></ul></td>
        <td>submit run "2024 Annual Estimates, revision 1" for review</td>
      </tr>
      <tr>
        <td class="mono muted">2026-08-19 09:12:31</td>
        <td class="mono">j.halvorsen@nso.example</td>
        <td><span class="pill is-accent">update</span> observation<br><span class="muted">value 33715.25</span></td>
        <td><ul class="changes"><li><span class="mono">value</span> <span class="muted">33402.10</span> → <span class="strong">33715.25</span></li></ul></td>
        <td>correcting a keying error in the manufacturing return, confirmed against the original survey form</td>
      </tr>
      <tr>
        <td class="mono muted">2026-08-19 09:04:18</td>
        <td class="mono">j.halvorsen@nso.example</td>
        <td><span class="pill is-accent">update</span> vintage<br><span class="muted">2024 revised</span></td>
        <td><ul class="changes"><li><span class="mono">frozen_at</span> <span class="muted">∅</span> → <span class="strong">2026-08-19T09:04:18+00:00</span></li></ul></td>
        <td>approval of run "2024 Annual Estimates, first release" freezes its input vintage</td>
      </tr>
      <tr>
        <td class="mono muted">2026-08-18 14:22:07</td>
        <td class="mono">r.okonkwo@nso.example</td>
        <td><span class="pill is-accent">update</span> source file<br><span class="muted">Merchandise trade 2024 Q1–Q4 · trade-2024.csv · committed</span></td>
        <td><ul class="changes"><li><span class="mono">status</span> <span class="muted">validated</span> → <span class="strong">committed</span></li></ul></td>
        <td>commit source file "Merchandise trade 2024 Q1–Q4" into vintage "2024 revised"</td>
      </tr>
      <tr>
        <td class="mono muted">2026-08-18 11:03:44</td>
        <td class="mono">r.okonkwo@nso.example</td>
        <td><span class="pill is-accent">update</span> membership<br><span class="muted">reviewer</span></td>
        <td><ul class="changes"><li><span class="mono">role</span> <span class="muted">viewer</span> → <span class="strong">reviewer</span></li></ul></td>
        <td>add a.pereira@nso.example as reviewer</td>
      </tr>
    </tbody>
  </table></div></section>

  <p><a class="backlink" href="#">Older entries →</a></p>

  <div class="callout is-note">
    <p class="callout-title">What this trail can and cannot be</p>
    <p class="muted">It is append-only in the database, not by convention: a
      trigger rejects any update or delete of an entry, including from a
      privileged role. Every audited write must carry a reason — a write
      without one is refused rather than recorded blank.</p>
    <p class="muted" style="margin-bottom:0">It records the change, not the
      intent behind it. A reason of "correcting a keying error" is a claim by
      the person who made the change, and the trail preserves that claim
      faithfully without vouching for it. Published figures are protected
      separately: a frozen vintage cannot be altered at all.</p>
  </div>
</main>"""


SCREENS = [
    ('landing', 'Landing', '/', LANDING,
     'Signed out. The three guarantees are the ones the brief calls '
     'non-negotiable, stated where a procuring office will read them.'),
    ('signin', 'Sign in', '/sign-in', SIGNIN,
     'Supabase Auth. Sessions are cookie-based and verified server-side on '
     'every request; the JWT claims are what <code>withRls()</code> hands to '
     'Postgres.'),
    ('orgs', 'Organizations', '/orgs', ORGS,
     'Row-Level Security does the filtering, not a <code>where</code> clause: '
     'an organization you are not a member of cannot appear in this list even '
     'if the query asks for it.'),
    ('org', 'Organization', '/orgs/nso-atlantis', ORG,
     'Roles are the four the brief names. The <em>Can</em> column exists '
     'because a compiler who does not know why they cannot publish will ask '
     'an admin to make them an admin.'),
    ('classifications', 'Classifications', '/orgs/…/classifications', CLASSIFICATIONS,
     'The provenance column is the honest one: seeds transcribed from the '
     'published structure are labelled as unverified until the official UN '
     'file is loaded and diffed against them.'),
    ('data', 'Source data', '/orgs/…/data', DATA,
     'Every upload is stored with its SHA-256, so a figure can be traced back '
     'to the exact bytes it came from — including which upload of a file that '
     'was re-sent.'),
    ('dataset', 'Mapping and validation', '/orgs/…/data/[id]', DATASET,
     'Errors block the commit; warnings do not. The stepper is the real state '
     'machine — a dataset cannot be committed before it is staged and '
     'validated.'),
    ('runs', 'Compilation runs', '/orgs/…/runs', RUNS,
     'A run pins the vintage it reads and the engine version that computed '
     'it. Those two pins are what make a published figure re-derivable.'),
    ('run', 'Run results', '/orgs/…/runs/[id]', RUN,
     'All three approaches side by side, the discrepancy between them, '
     'drill-down to the source rows behind a cell, and the non-additivity '
     'note that stops chain-linking being reported as a bug.'),
    ('audit', 'Audit trail', '/orgs/…/audit', AUDIT,
     'Non-negotiable 2 made readable. Every change with its actor, its '
     'field-level diff and the reason recorded at the time — append-only in '
     'the database, and filterable by a URL an auditor can cite.'),
    ('quarterly', 'Quarterly run', '/orgs/…/runs/[id]', QUARTERLY,
     'A quarterly run benchmarked to the annual accounts by the Denton '
     'method. The indicator is kept beside the reconciled figure, because the '
     'ratio between them is how a compiler judges the indicator.'),
]


def build() -> str:
    app_css = scoped_app_css()
    rail = []
    frames = []
    groups = [('Getting in', 2), ('Setting up', 3), ('Compiling', 6)]
    i = 0
    for label, count in groups:
        rail.append(f'<p class="rail-group">{label}</p>')
        for key, name, route, _, _note in SCREENS[i:i + count]:
            current = ' aria-current="true"' if key == 'landing' else ''
            rail.append(
                f'<button type="button" data-screen="{key}"{current}>{name}'
                f'<span class="route">{route}</span></button>')
        i += count

    notes = {}
    for key, _name, route, markup, note in SCREENS:
        hidden = '' if key == 'landing' else ' hidden'
        frames.append(f'<div class="app" data-frame="{key}"{hidden}>{markup}</div>')
        notes[key] = (route, note)

    notes_js = ',\n    '.join(
        f'{k}: [{route!r}, {note!r}]'.replace("'", '"')
        for k, (route, note) in notes.items())

    return TEMPLATE.format(
        app_css=app_css,
        rail='\n    '.join(rail),
        frames='\n'.join(frames),
        notes=notes_js,
    )


TEMPLATE = '''<title>Compilation Platform Screens</title>

<style>
  /* --- Preview chrome ---------------------------------------------------
     Deliberately unlike the application: cool grey, mono-labelled, so
     nothing here can be mistaken for part of the product. */
  :root {{
    --chrome-bg: #eceef2;
    --chrome-surface: #ffffff;
    --chrome-surface-2: #f4f6f9;
    --chrome-line: #d3d9e2;
    --chrome-fg: #17202b;
    --chrome-muted: #5a6779;
    --chrome-accent: #1d4ed8;
    --chrome-warn: #9a6200;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --chrome-bg: #101720;
      --chrome-surface: #18212c;
      --chrome-surface-2: #202b39;
      --chrome-line: #2b3847;
      --chrome-fg: #e7edf4;
      --chrome-muted: #93a1b3;
      --chrome-accent: #6aa4fb;
      --chrome-warn: #e8b451;
    }}
  }}
  :root[data-theme="dark"] {{
    --chrome-bg: #101720;
    --chrome-surface: #18212c;
    --chrome-surface-2: #202b39;
    --chrome-line: #2b3847;
    --chrome-fg: #e7edf4;
    --chrome-muted: #93a1b3;
    --chrome-accent: #6aa4fb;
    --chrome-warn: #e8b451;
  }}

  * {{ box-sizing: border-box; }}

  body {{
    margin: 0;
    background: var(--chrome-bg);
    color: var(--chrome-fg);
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.5;
  }}

  .masthead {{
    padding: 1.75rem 1.5rem 1.25rem;
    border-bottom: 1px solid var(--chrome-line);
    max-width: 82rem;
    margin: 0 auto;
  }}
  .masthead h1 {{
    margin: 0 0 0.35rem;
    font-size: 1.35rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }}
  .masthead p {{ margin: 0; color: var(--chrome-muted); font-size: 0.92rem; max-width: 64ch; }}

  .notice {{ max-width: 82rem; margin: 1.25rem auto 0; padding: 0 1.5rem; }}
  .notice-inner {{
    border: 1px solid var(--chrome-line);
    border-left: 3px solid var(--chrome-warn);
    background: var(--chrome-surface);
    border-radius: 6px;
    padding: 0.85rem 1rem;
    font-size: 0.88rem;
    color: var(--chrome-muted);
  }}
  .notice-inner strong {{ color: var(--chrome-fg); font-weight: 600; }}
  .notice-inner code {{ font-family: ui-monospace, monospace; font-size: 0.94em; color: var(--chrome-fg); }}

  .shell {{
    max-width: 82rem;
    margin: 0 auto;
    padding: 1.25rem 1.5rem 4rem;
    display: grid;
    grid-template-columns: 17rem minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }}
  @media (max-width: 62rem) {{ .shell {{ grid-template-columns: minmax(0, 1fr); }} }}

  .rail {{
    background: var(--chrome-surface);
    border: 1px solid var(--chrome-line);
    border-radius: 8px;
    padding: 0.5rem;
    position: sticky;
    top: 1rem;
  }}
  @media (max-width: 62rem) {{ .rail {{ position: static; }} }}

  .rail-group {{
    padding: 0.75rem 0.65rem 0.3rem;
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--chrome-muted);
    margin: 0;
  }}
  .rail button {{
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
    color: var(--chrome-fg);
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }}
  .rail button:hover {{ background: var(--chrome-surface-2); }}
  .rail button:focus-visible {{ outline: 2px solid var(--chrome-accent); outline-offset: -2px; }}
  .rail button[aria-current="true"] {{
    background: var(--chrome-surface-2);
    box-shadow: inset 2px 0 0 var(--chrome-accent);
  }}
  .rail .route {{
    display: block;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--chrome-muted);
    margin-top: 0.1rem;
    overflow-wrap: anywhere;
  }}

  .stage {{ min-width: 0; }}
  .stage-bar {{
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.85rem;
    background: var(--chrome-surface);
    border: 1px solid var(--chrome-line);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    color: var(--chrome-muted);
  }}
  .dots {{ display: flex; gap: 0.35rem; flex: none; }}
  .dots i {{ width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--chrome-line); display: block; }}
  .stage-bar .path {{ overflow-wrap: anywhere; flex: 1; }}
  .stage-bar .theme {{
    flex: none;
    border: 1px solid var(--chrome-line);
    background: var(--chrome-surface-2);
    color: var(--chrome-muted);
    border-radius: 5px;
    padding: 0.15rem 0.5rem;
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }}
  .stage-bar .theme:hover {{ color: var(--chrome-fg); }}

  .viewport {{
    border: 1px solid var(--chrome-line);
    border-radius: 0 0 8px 8px;
    overflow: hidden;
  }}

  .screen-note {{
    margin: 0.85rem 0 0;
    font-size: 0.86rem;
    color: var(--chrome-muted);
    max-width: 72ch;
  }}
  .screen-note code {{ font-family: ui-monospace, monospace; font-size: 0.94em; color: var(--chrome-fg); }}

  [hidden] {{ display: none !important; }}

  /* --- The application ---------------------------------------------------
     Everything below is src/app/globals.css, generated by
     scripts/build-preview.py: the same declarations, re-scoped under .app so
     they cannot touch the chrome, and with the dark palette bound to the
     frame's own toggle instead of the reader's OS setting. */
{app_css}

  /* Inside a frame, the frame is the column. */
  .app main {{ max-width: none; }}
  .app main.narrow > * {{ max-width: 34rem; }}
  /* This file is a fragment: the doctype is added when it is served. If it is
     opened raw the browser falls into quirks mode, where tables do not inherit
     colour from their ancestors and every figure turns dark-on-dark. */
  .app table {{ color: inherit; }}
</style>

<header class="masthead">
  <h1>Compilation Platform Screens</h1>
  <p>
    The eleven screens of the SNA 2008 GDP compilation platform, from sign-in
    through to a quarterly run benchmarked to the annual accounts.
  </p>
</header>

<div class="notice">
  <div class="notice-inner">
    <strong>What this is.</strong> Each frame is rendered from the
    application's own stylesheet — <code>src/app/globals.css</code>, read at
    build time and re-scoped, not re-typed — and markup mirroring the real page
    components, filled with representative data for a fictional statistical
    office. It is not a screenshot of a running deployment: the authenticated
    pages need a live Supabase project, which is the deployment still waiting on
    credentials. Buttons and links are inert. Every figure shown is invented.
  </div>
</div>

<div class="shell">
  <nav class="rail" aria-label="Screens">
    {rail}
  </nav>

  <div class="stage">
    <div class="stage-bar">
      <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="path" id="stage-path">nso-atlantis.gdp.example /</span>
      <button type="button" class="theme" id="theme-toggle" aria-pressed="false">Dark</button>
    </div>
    <div class="viewport" id="viewport">
{frames}
    </div>
    <p class="screen-note" id="screen-note"></p>
  </div>
</div>

<script>
  const NOTES = {{
    {notes}
  }};
  const rail = document.querySelectorAll('.rail button');
  const frames = document.querySelectorAll('[data-frame]');
  const path = document.getElementById('stage-path');
  const note = document.getElementById('screen-note');
  const toggle = document.getElementById('theme-toggle');
  let dark = false;

  function show(key) {{
    rail.forEach((b) => b.setAttribute('aria-current', String(b.dataset.screen === key)));
    frames.forEach((f) => {{ f.hidden = f.dataset.frame !== key; }});
    const [route, text] = NOTES[key];
    path.textContent = 'nso-atlantis.gdp.example ' + route;
    note.innerHTML = text;
    window.scrollTo({{ top: 0, behavior: 'smooth' }});
  }}

  rail.forEach((b) => b.addEventListener('click', () => show(b.dataset.screen)));

  toggle.addEventListener('click', () => {{
    dark = !dark;
    frames.forEach((f) => {{
      if (dark) f.setAttribute('data-theme', 'dark');
      else f.removeAttribute('data-theme');
    }});
    toggle.textContent = dark ? 'Light' : 'Dark';
    toggle.setAttribute('aria-pressed', String(dark));
  }});

  show('landing');
</script>
'''


if __name__ == '__main__':
    out = Path(sys.argv[1])
    out.write_text(build())
    print(f'wrote {out} ({out.stat().st_size // 1024} KB)')

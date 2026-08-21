// A local stand-in for Supabase Auth, for end-to-end tests only.
//
// WHY THIS EXISTS. The Playwright suite drives the real application: the real
// Next.js server, the real server actions, the real Postgres with the real
// RLS policies. The one piece it cannot have locally is the identity
// provider — `supabase.auth.getUser()` revalidates the JWT against Supabase's
// hosted Auth service on every request, by design, and there is no Supabase
// project until the owner creates one.
//
// So this speaks enough of the GoTrue HTTP API for `@supabase/ssr` to work
// against it: issue a session, hand back the user for a bearer token, sign
// out. Everything downstream of that — the claims, the cookie handling, the
// middleware gate, `withRls()`, every policy — is the production code path,
// untouched.
//
// WHAT IS THEREFORE NOT TESTED by the e2e suite: password strength rules,
// rate limiting, email confirmation delivery, OAuth, MFA. Those belong to
// Supabase Auth and will behave as Supabase configures them. What IS tested
// is that the application uses an identity correctly once it has one.
//
// NEVER import this from application code, and never run it anywhere but a
// test. It accepts any password it was given at sign-up and signs no tokens
// anyone should trust.
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import postgres from 'postgres';

const PORT = Number(process.env.AUTH_STUB_PORT ?? 54330);
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:54329/gdp_test';

/* Not a secret in any meaningful sense — this server is both the issuer and
   the only verifier, and it lives for the length of a test run. */
const SECRET = 'e2e-auth-stub-secret';
const TOKEN_TTL_SECONDS = 60 * 60;

const db = postgres(DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });

/** email → { id, password }. The identity provider is where credentials live. */
const credentials = new Map();
/** refresh token → email. */
const refreshTokens = new Map();

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mintAccessToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      aud: 'authenticated',
      role: 'authenticated',
      iss: `http://localhost:${PORT}/auth/v1`,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
    }),
  );
  const signature = createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
}

function userObject(user) {
  const now = new Date().toISOString();
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: now,
    confirmed_at: now,
    last_sign_in_at: now,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    is_anonymous: false,
    created_at: now,
    updated_at: now,
  };
}

function session(user) {
  const refreshToken = randomUUID();
  refreshTokens.set(refreshToken, user.email);
  return {
    access_token: mintAccessToken(user),
    token_type: 'bearer',
    expires_in: TOKEN_TTL_SECONDS,
    expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    user: userObject(user),
  };
}

/**
 * Create the user row the application's foreign keys point at. `auth.users`
 * is the real table here — the test shim's version of it — so memberships,
 * audit entries and `created_by` all behave exactly as in production.
 */
async function upsertUser(email) {
  const [row] = await db`
    insert into auth.users (email) values (${email})
    on conflict (email) do update set email = excluded.email
    returning id
  `;
  return { id: row.id, email };
}

function send(res, status, body) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
  });
  res.end(payload);
}

/** GoTrue's error shape: the client reads `msg`, then `message`. */
function fail(res, status, msg, code = 'invalid_credentials') {
  send(res, status, { code: status, error_code: code, msg, message: msg });
}

function bearer(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Decode without verifying — this process signed it moments ago. */
function claimsOf(token) {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/^\/auth\/v1/, '');

  if (req.method === 'OPTIONS') return send(res, 204, null);

  try {
    if (path === '/settings' && req.method === 'GET') {
      return send(res, 200, {
        external: { email: true },
        disable_signup: false,
        mailer_autoconfirm: true,
        autoconfirm: true,
      });
    }

    if (path === '/signup' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      if (!email || !password) {
        return fail(res, 400, 'Email and password are required', 'validation_failed');
      }
      if (credentials.has(email)) {
        return fail(res, 400, 'User already registered', 'user_already_exists');
      }
      const user = await upsertUser(email);
      credentials.set(email, { id: user.id, password });

      // A real project with email confirmation enabled returns no session and
      // the application shows "check your email". That branch is worth
      // covering, so an address opting into it gets that behaviour.
      if (email.startsWith('needs-confirm')) {
        return send(res, 200, { ...userObject(user), session: null });
      }
      return send(res, 200, session(user));
    }

    if (path === '/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      const body = await readBody(req);

      if (grant === 'password') {
        const record = credentials.get(body.email);
        if (!record || record.password !== body.password) {
          return fail(res, 400, 'Invalid login credentials');
        }
        return send(res, 200, session({ id: record.id, email: body.email }));
      }

      if (grant === 'refresh_token') {
        const email = refreshTokens.get(body.refresh_token);
        if (!email) return fail(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
        refreshTokens.delete(body.refresh_token);
        const record = credentials.get(email);
        return send(res, 200, session({ id: record.id, email }));
      }

      return fail(res, 400, `Unsupported grant_type ${grant}`, 'validation_failed');
    }

    if (path === '/user' && req.method === 'GET') {
      const token = bearer(req);
      const claims = token ? claimsOf(token) : null;
      if (!claims?.sub) return fail(res, 401, 'invalid claim: missing sub claim', 'bad_jwt');
      if (claims.exp * 1000 < Date.now()) {
        return fail(res, 401, 'JWT expired', 'bad_jwt');
      }
      return send(res, 200, userObject({ id: claims.sub, email: claims.email }));
    }

    if (path === '/logout' && req.method === 'POST') return send(res, 204, null);

    return fail(res, 404, `No stub route for ${req.method} ${path}`, 'not_found');
  } catch (e) {
    return fail(res, 500, e instanceof Error ? e.message : String(e), 'unexpected_failure');
  }
});

server.listen(PORT, () => {
  process.stdout.write(`auth stub listening on http://localhost:${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    db.end({ timeout: 1 }).finally(() => process.exit(0));
  });
}

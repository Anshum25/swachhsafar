// In-browser fake of Firebase Auth (a FAKE project) and of the FastAPI endpoints the sync engine uses.
// Every Google API and /api/v1 request is answered or refused by Playwright routing, so nothing leaves
// the browser. Each user gets their own unsigned ID token; the server records whose token delivered
// each operation, so tests can check that records are only ever sent with their owner's credentials.
import { changesFixture } from '../helpers/operationalFixtures.js';
import { DEFAULT_POLICY } from '../../src/database/masterDataRepository.js';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function tokenFor(email, uid) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'RS256', kid: 'e2e', typ: 'JWT' })}.${b64url({
    iss: 'https://securetoken.google.com/swachh-safar-e2e-fake', aud: 'swachh-safar-e2e-fake', auth_time: now, user_id: uid, sub: uid,
    iat: now, exp: now + 30 * 86400, email, email_verified: true, firebase: { identities: { email: [email] }, sign_in_provider: 'password' },
  })}.c2ln`;
}

const emailOf = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).email;
  } catch {
    return null;
  }
};

// `users`: { [email]: meResponse }. `today`: business date the fixture journeys are anchored to.
export function createFakeNetwork({ users, today }) {
  const accounts = Object.fromEntries(Object.keys(users).map((email, i) => [email, { uid: `fb-e2e-${i}`, token: tokenFor(email, `fb-e2e-${i}`) }]));
  const server = { connected: true, offlineHits: [], batches: [], uploads: new Map(), mediaInit: [], masterWrites: [], cspViolations: [], faceProfiles: [] };
  // Master data held by the fake server, seeded like /sync/changes, with backend permission checks.
  const seed = changesFixture(today);
  const masters = {
    departments: seed.complaint_departments, categories: seed.complaint_categories, items: seed.inventory_items,
    banks: seed.question_banks,
    // Employees the Users tab lists. `signins` records what the server was asked to create, so a test can
    // tell a real provisioning apart from a page that merely looks right.
    staff: [],
    // backend get_policy: PolicySettings with defaults for anything the division has not set
    policies: Object.fromEntries(Object.entries(seed.policies).map(([d, p]) => [d, { ...DEFAULT_POLICY, ...p }])),
  };

  async function install(context) {
    // The preview server sends the production CSP (deploy/nginx/security-headers.conf); record anything it blocks.
    await context.exposeBinding('__e2eCspViolation', (_source, v) => server.cspViolations.push(v)).catch(() => {});
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        globalThis.__e2eCspViolation?.({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber });
      });
    });
    await context.route(/googleapis\.com|firebaseinstallations|gstatic/, async (route) => {
      const req = route.request();
      const url = req.url();
      if (!server.connected) {
        server.offlineHits.push(url);
        return route.abort('internetdisconnected');
      }
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      const body = req.postDataJSON?.() ?? {};
      if (url.includes('accounts:signInWithPassword')) {
        const acct = accounts[body.email];
        if (!acct) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } }) });
        return json({ kind: 'identitytoolkit#VerifyPasswordResponse', localId: acct.uid, email: body.email, displayName: '', idToken: acct.token, registered: true, refreshToken: `refresh-${acct.uid}`, expiresIn: '2592000' });
      }
      if (url.includes('accounts:signInWithCustomToken')) {
        const customToken = body.token;
        const acct = Object.values(accounts).find((a) => a.token === customToken) || Object.values(accounts)[0];
        return json({ kind: 'identitytoolkit#SignInWithCustomTokenResponse', idToken: acct ? acct.token : customToken, refreshToken: `refresh-${acct?.uid || 'user'}`, expiresIn: '2592000' });
      }
      if (url.includes('accounts:lookup')) {
        const email = emailOf(body.idToken);
        const acct = accounts[email];
        return json({ kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: acct.uid, email, emailVerified: true, providerUserInfo: [{ providerId: 'password', email, federatedId: email, rawId: email }], lastLoginAt: `${Date.now()}`, createdAt: `${Date.now()}` }] });
      }
      if (url.includes('securetoken.googleapis.com')) {
        const acct = Object.values(accounts).find((a) => String(req.postData() ?? '').includes(a.uid)) ?? Object.values(accounts)[0];
        return json({ access_token: acct.token, expires_in: '2592000', token_type: 'Bearer', refresh_token: `refresh-${acct.uid}`, id_token: acct.token, user_id: acct.uid, project_id: '0' });
      }
      return route.abort('blockedbyclient');
    });

    await context.route('**/api/v1/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, '');
      if (!server.connected) {
        server.offlineHits.push(req.url());
        return route.abort('internetdisconnected');
      }
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

      if (req.method() === 'GET' && path === '/auth/captcha/image') {
        // Fake: the image shows 12345 (plain SVG text is fine for a test double).
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="64"><rect width="200" height="64" fill="#eef"/><text x="40" y="42" font-size="30">12345</text></svg>';
        return json({ algorithm: 'TEXT', token: 'e2e-token', image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, length: 5,
          expires_at: new Date(Date.now() + 300_000).toISOString() });
      }
      if (req.method() === 'POST' && path === '/auth/captcha/check') {
        const ok = req.postDataJSON()?.captcha?.answer === '12345';
        return ok ? route.fulfill({ status: 204 }) : json({ error: { code: 'captcha_invalid', message: 'The security check failed.' } }, 422);
      }
      if (req.method() === 'GET' && path === '/auth/captcha') {
        return json({
          algorithm: 'SHA-256',
          challenge: 'dfe50f1336423b96f987a242b4f72360301ccd0d1d2cd8801330952da766e3b9',
          salt: 'e2e-salt',
          signature: 'e2e-sig',
          maxnumber: 10,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }

      if (req.method() === 'POST' && path === '/auth/login') {
        const body = req.postDataJSON() || {};
        const username = (body.username || '').toLowerCase();
        const targetEmail = Object.keys(users).find((e) => e.toLowerCase() === username || users[e].user?.emp_id?.toLowerCase() === username);
        if (body.captcha?.algorithm === 'TEXT' && body.captcha.answer !== '12345') {
          return json({ error: { code: 'captcha_invalid', message: 'The security check failed.' } }, 422);
        }
        if (!targetEmail || !accounts[targetEmail] || body.password === 'Wrong-Password-1') {
          return json({ error: { code: 'auth/invalid-login-credentials', message: 'Employee ID or password is incorrect.' } }, 401);
        }
        const acct = accounts[targetEmail];
        return json({
          custom_token: acct.token,
          session_id: 'e2e-session-id',
          device_id: body.device?.id || 'e2e-device',
          method: 'password',
        });
      }

      if (req.method() === 'POST' && path === '/auth/otp/request') {
        return json({ expires_in_seconds: 300, resend_after_seconds: 60 });
      }

      if (req.method() === 'POST' && path === '/auth/otp/verify') {
        const body = req.postDataJSON() || {};
        if (body.code && body.code !== '123456') {
          return json({ error: { code: 'otp_invalid', message: 'The 6-digit code is incorrect or expired. Request a new code.' } }, 401);
        }
        const firstEmail = Object.keys(users)[0];
        const acct = accounts[firstEmail];
        return json({
          custom_token: acct.token,
          session_id: 'e2e-session-id',
          device_id: body.device?.id || 'e2e-device',
          method: 'otp',
        });
      }

      if (req.method() === 'GET' && path === '/security/network') {
        return json({ ip: '127.0.0.1', vpn: false, source: 'fake', detail: null, server_time: new Date().toISOString() });
      }

      const caller = emailOf(String(req.headers().authorization ?? '').replace(/^Bearer /, ''));
      if (!caller || !users[caller]) return json({ error: { code: 'unauthenticated', message: 'No valid token' } }, 401);
      if (req.method() === 'GET' && path === '/auth/me') {
        const u = users[caller];
        const nowIso = new Date().toISOString();
        const expIso = new Date(Date.now() + 24 * 3_600_000).toISOString();
        return json({
          ...u,
          offline_lease: {
            lease_id: 'e2e-lease-id',
            emp_id: u.user?.emp_id || '',
            user_id: u.user?.id || '',
            device_id: 'unspecified',
            session_id: 'e2e-session-id',
            issued_at: nowIso,
            expires_at: expIso,
            authorization_version: 1,
            policy_version: 1,
            permitted_operations: ['attendance.record', 'inspection.record', 'feedback.passenger.start', 'feedback.railway.create'],
            signature: 'fake-valid-signature-000000000000000000000000000000000000000000000000',
          },
        });
      }
      if (req.method() === 'GET' && path === '/sync/changes') {
        return json({ ...changesFixture(today), complaint_departments: masters.departments, complaint_categories: masters.categories,
          inventory_items: masters.items, question_banks: masters.banks, policies: masters.policies, face_profiles: server.faceProfiles });
      }
      if (req.method() === 'GET' && path.startsWith('/media/')) return json({ error: { code: 'not_found', message: 'no' } }, 404);
      if (req.method() === 'POST' && path === '/media') {
        const body = req.postDataJSON();
        server.mediaInit.push(body);
        return json({ ...body, status: 'pending' }, 201);
      }
      if (req.method() === 'PUT' && /^\/media\/[^/]+\/content$/.test(path)) {
        server.uploads.set(path.split('/')[2], req.postDataBuffer());
        return json({ status: 'uploaded' });
      }
      if (req.method() === 'POST' && path === '/sync/batch') {
        const body = req.postDataJSON();
        server.batches.push(...body.operations.map((o) => ({ ...o, deliveredBy: caller })));
        return json({
          server_time: new Date().toISOString(),
          results: body.operations.map((o) => ({ op_id: o.op_id, type: o.type, outcome: 'acknowledged', http_status: 201, entity_id: o.payload.id, replayed: false, error: null, server_timestamp: new Date().toISOString() })),
        });
      }
      const master = handleMaster(req.method(), path, new URL(req.url()).searchParams, req.postDataJSON?.() ?? null, users[caller]);
      if (master) {
        if (req.method() !== 'GET' && master.status < 300) server.masterWrites.push({ method: req.method(), path, by: caller });
        return json(master.body, master.status);
      }
      // Every other endpoint behaves as unreachable, so the screens must use the device database.
      return route.abort('connectionrefused');
    });
  }

  // Backend rules (services/complaints.py, inventory.py, feedback.py, api/v1/org.py), reduced to what the screens use.
  function handleMaster(method, path, query, body, me) {
    const can = (perm, d) => me.divisions[d]?.includes(perm);
    const member = (d) => !!me.divisions[d];
    const forbidden = { status: 403, body: { error: { code: 'permission_denied', message: 'Missing permission' } } };
    const outside = { status: 403, body: { error: { code: 'division_forbidden', message: 'Outside your authorized divisions' } } };
    const invalid = (message) => ({ status: 422, body: { error: { code: 'validation_error', message } } });
    const now = new Date().toISOString();
    const list = (rows) => { const d = query.get('division_id'); return member(d) ? { status: 200, body: rows.filter((r) => r.division_id === d) } : outside; };
    const patch = (rows, id, perm) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
      if (!can(perm, row.division_id)) return forbidden;
      if ('division_id' in body) return invalid('division_id: Extra inputs are not permitted');
      Object.assign(row, body, { updated_at: now });
      return { status: 200, body: row };
    };
    let m;
    // ---- employees and their sign-ins ----------------------------------------------------------------
    if (method === 'GET' && path === '/users') {
      const d = query.get('division_id');
      if (d && !member(d)) return outside;
      return { status: 200, body: { items: masters.staff.filter((u) => u.division_id === d), total: masters.staff.length, page: 1, page_size: 200 } };
    }
    if (method === 'POST' && path === '/users') {
      if (!can('users.manage', body.division_id)) return forbidden;
      // The server creates the sign-in with the employee: linked straight away, and the generated password
      // is returned once (absent when the administrator chose one).
      const generated = body.email && !body.password ? 'gen-pass-1234' : null;
      const row = {
        id: crypto.randomUUID(), status: 'active', updated_at: now, name_hindi: null, gender: null, lang: 'en',
        ...body, email: body.email ? body.email.toLowerCase() : null,
        firebase_linked: !!body.email,
        temp_password: generated,
        signin: body.email ? 'created' : null,
      };
      delete row.password;
      masters.staff.push(row);
      return { status: 201, body: row };
    }
    if ((m = path.match(/^\/users\/([^/]+)\/signin$/)) && method === 'POST') {
      const row = masters.staff.find((u) => u.id === m[1]);
      if (!row) return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
      if (!can('users.manage', row.division_id)) return forbidden;
      if (row.firebase_linked) return invalid('This employee can already sign in');
      Object.assign(row, { firebase_linked: true, signin: 'created', temp_password: body.password ? null : 'gen-pass-5678', updated_at: now });
      return { status: 200, body: row };
    }
    if (method === 'GET' && path === '/complaints/departments') return list(masters.departments);
    if (method === 'GET' && path === '/complaints/categories') return list(masters.categories);
    if (method === 'GET' && path === '/inventory/items') return list(masters.items);
    if (method === 'GET' && path === '/feedback/question-banks') {
      const d = query.get('division_id');
      if (d && !member(d)) return outside;
      return { status: 200, body: masters.banks.filter((b) => (b.division_id ?? null) === (d || null)) };
    }
    if ((m = path.match(/^\/divisions\/([^/]+)\/policy$/))) {
      if (method === 'GET') return member(m[1]) ? { status: 200, body: { ...masters.policies[m[1]] } } : outside;
      if (!can('policies.manage', m[1])) return forbidden;
      masters.policies[m[1]] = body;
      return { status: 200, body };
    }
    if (method === 'POST' && path === '/complaints/departments') {
      if (!can('complaints.masters.manage', body.division_id)) return forbidden;
      const row = { id: crypto.randomUUID(), is_active: true, ...body };
      masters.departments.push(row);
      return { status: 201, body: row };
    }
    if (method === 'POST' && path === '/complaints/categories') {
      if (!can('complaints.masters.manage', body.division_id)) return forbidden;
      const row = { id: crypto.randomUUID(), parent_id: null, default_department_id: null, sla_hours: null, sort_order: 0, is_active: true, ...body };
      masters.categories.push(row);
      return { status: 201, body: row };
    }
    if (method === 'POST' && path === '/inventory/items') {
      if (!can('inventory.items.manage', body.division_id)) return forbidden;
      if (masters.items.some((i) => i.division_id === body.division_id && i.name.toLowerCase() === body.name.toLowerCase())) {
        return { status: 409, body: { error: { code: 'conflict', message: 'Item already exists in this division' } } };
      }
      const row = { id: crypto.randomUUID(), is_active: true, updated_at: now, ...body };
      masters.items.push(row);
      return { status: 201, body: row };
    }
    if (method === 'POST' && path === '/feedback/question-banks') {
      if (!can('questions.manage', body.division_id)) return forbidden;
      const row = { id: crypto.randomUUID(), is_active: false, updated_at: now, ...body, questions: body.questions.map((q, i) => ({ id: crypto.randomUUID(), position: i + 1, ...q })) };
      masters.banks.push(row);
      return { status: 201, body: row };
    }
    if (method === 'POST' && (m = path.match(/^\/feedback\/question-banks\/([^/]+)\/activate$/))) {
      const bank = masters.banks.find((b) => b.id === m[1]);
      if (!can('questions.manage', bank.division_id)) return forbidden;
      for (const b of masters.banks) if (b.audience === bank.audience && b.division_id === bank.division_id) b.is_active = b.id === bank.id;
      return { status: 200, body: bank };
    }
    if (method === 'PATCH' && (m = path.match(/^\/complaints\/departments\/([^/]+)$/))) return patch(masters.departments, m[1], 'complaints.masters.manage');
    if (method === 'PATCH' && (m = path.match(/^\/complaints\/categories\/([^/]+)$/))) return patch(masters.categories, m[1], 'complaints.masters.manage');
    if (method === 'PATCH' && (m = path.match(/^\/inventory\/items\/([^/]+)$/))) return patch(masters.items, m[1], 'inventory.items.manage');
    return null;
  }

  return { server, masters, install };
}

export const FIELD_PERMS = [
  'journeys.read', 'attendance.submit', 'attendance.read', 'inspections.submit', 'inspections.read', 'feedback.collect',
  'feedback.railway.submit', 'feedback.read', 'complaints.create', 'complaints.read', 'dashboard.read',
];

export function meFor({ id, name, email, roleId, divisionId, perms = FIELD_PERMS }) {
  return {
    user: {
      id, emp_id: `EMP-${name.split(' ')[0]}`, name, name_hindi: null, email, mobile: null, gender: null, designation: null, lang: 'en',
      role_id: roleId, division_id: divisionId, status: 'active', firebase_linked: true, updated_at: '2026-11-01T00:00:00Z',
    },
    divisions: { [divisionId]: perms },
  };
}

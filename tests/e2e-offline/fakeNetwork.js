// In-browser fake of the FastAPI endpoints: sign-in (which issues backend session tokens) and everything
// the sync engine uses. Every Google API and /api/v1 request is answered or refused by Playwright routing,
// so nothing leaves the browser. Each user gets their own session token; the server records whose token
// delivered each operation, so tests can check that records are only ever sent with their owner's credentials.
import { expect } from '@playwright/test';
import { changesFixture } from '../helpers/operationalFixtures.js';
import { DEFAULT_POLICY } from '../../src/database/masterDataRepository.js';

// A location on the form, however it got there. Attendance asks for the fix as soon as the dialog opens,
// so there is usually nothing to tap and the button has already become "Refresh"; other forms still wait
// for a tap. Either way this returns once the fix is on screen.
export async function ensureGps(scope) {
  const value = scope.getByTestId('gps-value');
  // Matches both labels on purpose: an automatic fetch renames the button from "Get GPS" to "Refresh"
  // the moment it succeeds, and a locator pinned to one of them stops matching mid-click.
  const button = scope.getByRole('button', { name: /Get GPS|Refresh/ });
  await expect(button).toBeEnabled({ timeout: 30_000 }); // an automatic fetch has finished, or never ran
  if (!(await value.isVisible().catch(() => false))) await button.click();
  await expect(value).toBeVisible({ timeout: 30_000 });
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// Same shape as a real session token (ss1.<session>.<secret>); the fake puts the e-mail in the secret so the
// server can tell callers apart without keeping a session table.
const tokenFor = (email, uid) => `ss1.${Buffer.from(uid).toString('hex')}.${b64url(email)}`;

const emailOf = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[2], 'base64url').toString());
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
    await context.route(/googleapis\.com|gstatic/, async (route) => {
      const req = route.request();
      const url = req.url();
      if (!server.connected) {
        server.offlineHits.push(url);
        return route.abort('internetdisconnected');
      }
      return route.abort('blockedbyclient'); // the app calls no Google API that the tests need answered
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
          access_token: acct.token, token_type: 'bearer',
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
          access_token: acct.token, token_type: 'bearer',
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
      const q = (query.get('q') ?? '').toLowerCase();
      const items = masters.staff.filter((u) => u.division_id === d && (!q || [u.name, u.emp_id, u.email].some((v) => v?.toLowerCase().includes(q))));
      return { status: 200, body: { items, total: items.length, page: 1, page_size: Number(query.get('page_size') ?? 200) } };
    }
    if (method === 'POST' && path === '/users') {
      if (!can('users.manage', body.division_id)) return forbidden;
      // The server creates the sign-in with the employee: linked straight away, and the generated password
      // is returned once (absent when the administrator chose one).
      const generated = body.email && !body.password ? 'gen-pass-1234' : null;
      const row = {
        id: crypto.randomUUID(), status: 'active', updated_at: now, name_hindi: null, gender: null, lang: 'en',
        ...body, email: body.email ? body.email.toLowerCase() : null,
        password_set: !!(body.email || body.password), face_enrolled: false, fingerprint_enrolled: false,
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
      if (row.password_set) return invalid('This employee can already sign in');
      Object.assign(row, { password_set: true, signin: 'created', temp_password: body.password ? null : 'gen-pass-5678', updated_at: now });
      return { status: 200, body: row };
    }
    // ---- one employee: profile, edit, password reset, status (api/v1/org.py) ----------------------------
    if ((m = path.match(/^\/users\/([^/]+)(\/[a-z]+)?$/)) && m[1] !== 'charge-maps') {
      const row = masters.staff.find((u) => u.id === m[1]);
      const sub = m[2] ?? '';
      if (!row || !member(row.division_id)) return { status: 404, body: { error: { code: 'not_found', message: 'User not found' } } };
      if (method === 'GET' && sub === '') return { status: 200, body: row };
      if (method === 'GET' && sub === '/account') {
        return { status: 200, body: { user_id: row.id, created_at: '2026-01-05T10:00:00Z', updated_at: row.updated_at, created_by: null,
          division_code: 'E2E', division_name: 'E2E Division', role_name: 'Janitor', password_set: row.password_set,
          password_changed_at: row.password_set ? '2026-02-01T09:00:00Z' : null, password_set_by: row.password_set ? 'admin' : null,
          last_sign_in_at: null, active_sessions: 0, permissions: ['attendance.submit', 'journeys.read'] } };
      }
      if (method === 'GET' && sub === '/face') return { status: 200, body: { user_id: row.id, enrolled: !!row.face_enrolled, samples: 0 } };
      if (method === 'GET' && sub === '/fingerprint') return { status: 200, body: { user_id: row.id, enrolled: !!row.fingerprint_enrolled, fingers: [] } };
      if (!can('users.manage', row.division_id)) return forbidden;
      if (method === 'PATCH' && sub === '') {
        if ('emp_id' in body || 'status' in body) return invalid('Extra inputs are not permitted');
        Object.assign(row, body, { updated_at: now });
        return { status: 200, body: row };
      }
      if (method === 'POST' && sub === '/password') {
        if (!body?.new_password || body.new_password.length < 8) return invalid('new_password: too short');
        server.passwordResets = [...(server.passwordResets ?? []), { id: row.id, length: body.new_password.length }];
        Object.assign(row, { password_set: true, updated_at: now });
        return { status: 200, body: { sessions_ended: 2 } };
      }
      if (method === 'POST' && sub === '/status') {
        Object.assign(row, { status: body.status, updated_at: now });
        return { status: 200, body: row };
      }
    }
    if (method === 'GET' && path === '/complaints/departments') return list(masters.departments);
    if (method === 'GET' && path === '/complaints/categories') return list(masters.categories);
    // ---- offices and the Super Admin overview (api/v1/clients.py, reports.py overview), read-only -------
    if (method === 'GET' && path === '/clients') return { status: 200, body: FAKE_CLIENTS };
    if (method === 'GET' && /^\/clients\/[^/]+\/wallet$/.test(path)) {
      return { status: 200, body: { client_id: FAKE_CLIENTS[1].id, office_id: '002', name: 'skydot', status: 'active', credit_balance: 509,
        credit_per_journey: 1, low_credit_threshold: 10, low_credit: false, journeys_covered: 509, added_this_month: 522, spent_this_month: 13,
        upcoming_journeys: 0, upcoming_cost: 0, recent: [1, 2, 3].map((i) => ({ id: `l${i}`, created_at: new Date().toISOString(), delta: -1,
          balance_after: 509 + i - 1, reason: 'journey_charge', journey_id: null, reference: null, note: null, created_by_id: null, is_system: true })) } };
    }
    if (method === 'GET' && path === '/dashboard/overview') {
      if (me.user.role_id !== 1 && !Object.values(me.divisions).some((p) => p.includes('dashboard.read'))) return forbidden;
      return { status: 200, body: fakeOverview(query, today) };
    }
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
      // Like the backend: answer options set the scale to 1..number of options.
      const scale = body.option_labels ? { scale_min: 1, scale_max: body.option_labels.length } : {};
      const row = { id: crypto.randomUUID(), is_active: false, updated_at: now, ...body, ...scale, questions: body.questions.map((q, i) => ({ id: crypto.randomUUID(), position: i + 1, ...q })) };
      masters.banks.push(row);
      return { status: 201, body: row };
    }
    if (method === 'POST' && (m = path.match(/^\/feedback\/question-banks\/([^/]+)\/activate$/))) {
      const bank = masters.banks.find((b) => b.id === m[1]);
      if (!can('questions.manage', bank.division_id)) return forbidden;
      for (const b of masters.banks) if (b.audience === bank.audience && b.division_id === bank.division_id) b.is_active = b.id === bank.id;
      return { status: 200, body: bank };
    }
    if (method === 'POST' && (m = path.match(/^\/feedback\/question-banks\/([^/]+)\/assign$/))) {
      const src = masters.banks.find((b) => b.id === m[1]);
      if (body.division_ids.some((d) => !can('questions.manage', d))) return forbidden;
      const out = body.division_ids.map((d) => {
        for (const b of masters.banks) if (b.audience === src.audience && b.division_id === d) b.is_active = false;
        if (src.division_id === d) { src.is_active = true; return src; }
        const copy = { ...src, id: crypto.randomUUID(), division_id: d, is_active: true, updated_at: now,
          questions: src.questions.map((q) => ({ ...q, id: crypto.randomUUID() })) };
        masters.banks.push(copy);
        return copy;
      });
      return { status: 200, body: out };
    }
    if (method === 'PATCH' && (m = path.match(/^\/complaints\/departments\/([^/]+)$/))) return patch(masters.departments, m[1], 'complaints.masters.manage');
    if (method === 'PATCH' && (m = path.match(/^\/complaints\/categories\/([^/]+)$/))) return patch(masters.categories, m[1], 'complaints.masters.manage');
    if (method === 'PATCH' && (m = path.match(/^\/inventory\/items\/([^/]+)$/))) return patch(masters.items, m[1], 'inventory.items.manage');
    return null;
  }

  return { server, masters, install };
}

// Two offices and a 30-day overview with a weekly rhythm, so the Super Admin dashboard has something to draw.
const FAKE_CLIENTS = [
  { id: '00000000-0000-4000-8000-0000000000c1', office_id: 'OFF-001', name: 'Default Office', status: 'active', enabled_modules: ['attendance', 'inspections', 'feedback', 'complaints', 'inventory', 'reports'], credit_balance: 120, credit_per_journey: 1, low_credit_threshold: 10 },
  { id: '00000000-0000-4000-8000-0000000000c2', office_id: '002', name: 'skydot', status: 'active', enabled_modules: ['attendance', 'inspections', 'feedback', 'complaints', 'reports'], credit_balance: 4, credit_per_journey: 1, low_credit_threshold: 10 },
];

function fakeOverview(query, today) {
  const to = query.get('date_to') || today;
  const from = query.get('date_from') || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 864e5).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
    const w = (i % 7) / 6;
    return { date, journeys: 3 + Math.round(4 * w), attendance: 20 + Math.round(18 * Math.sin(i / 3) ** 2), inspections: 12 + (i % 5) * 2,
      passenger_feedback: 8 + (i % 4), railway_feedback: i % 3, complaints: (i * 7) % 5 };
  });
  const sum = (k) => daily.reduce((n, d) => n + d[k], 0);
  return {
    date_from: from, date_to: to, daily,
    totals: { offices: 2, headquarters: 2, stations: 5, users_active: 48, users_inactive: 3, journeys_active: 4, journeys_scheduled: 9,
      journeys: sum('journeys'), journeys_cancelled: 2, attendance: sum('attendance'), inspections: sum('inspections'),
      passenger_feedback: sum('passenger_feedback'), railway_feedback: sum('railway_feedback'), complaints: sum('complaints'),
      complaints_open: 6, complaints_overdue: 1, credit_balance: 124, credits_added: 200, credits_spent: sum('journeys') },
    complaints_by_status: { created: 3, in_process: 2, forwarded: 1, completed: 17 },
    users_by_role: [{ role_id: 1, role: 'Super Admin', count: 1 }, { role_id: 2, role: 'Admin', count: 2 }, { role_id: 3, role: 'Manager', count: 4 },
      { role_id: 4, role: 'Supervisor/EHK', count: 9 }, { role_id: 5, role: 'Janitor', count: 32 }, { role_id: 6, role: 'Contractor', count: 3 }],
    offices: [
      { client_id: FAKE_CLIENTS[0].id, office_id: 'OFF-001', name: 'Default Office', status: 'active', divisions: 4, users: 36, journeys: 90, attendance: 610, inspections: 380, complaints_open: 4, credit_balance: 120, credits_spent: 90 },
      { client_id: FAKE_CLIENTS[1].id, office_id: '002', name: 'skydot', status: 'active', divisions: 3, users: 12, journeys: 41, attendance: 240, inspections: 150, complaints_open: 2, credit_balance: 4, credits_spent: 41 },
    ],
  };
}

export const FIELD_PERMS = [
  'journeys.read', 'attendance.submit', 'attendance.read', 'inspections.submit', 'inspections.read', 'feedback.collect',
  'feedback.railway.submit', 'feedback.read', 'complaints.create', 'complaints.read', 'dashboard.read',
];

export function meFor({ id, name, email, roleId, divisionId, perms = FIELD_PERMS }) {
  return {
    user: {
      id, emp_id: `EMP-${name.split(' ')[0]}`, name, name_hindi: null, email, mobile: null, gender: null, designation: null, lang: 'en',
      role_id: roleId, division_id: divisionId, status: 'active', password_set: true, face_enrolled: false, fingerprint_enrolled: false, updated_at: '2026-11-01T00:00:00Z',
    },
    divisions: { [divisionId]: perms },
  };
}

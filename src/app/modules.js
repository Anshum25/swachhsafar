// The operational modules of the app: one registry for routing, navigation and checkpoint ownership.
// `any`: the module shows when the user holds at least one of these permissions in any division (the
// screens then check the record's own division before offering an action; the server re-checks).
// `module`: the client (office) module this screen belongs to, as the backend names it
// (app/security/catalog.py). A client is subscribed to a set of modules; what it has not bought is
// hidden here and refused by the server. `null` means the screen is part of the platform and is never
// switched off -- the dashboard, your own profile, the security status.
//
// Two layers decide what a user sees, and both have to allow it:
//   1. the client's subscription  -- what the office pays for          (`module`)
//   2. the user's role            -- what that person may do with it   (`any`)
// The server applies both: an unsubscribed module's permissions are stripped from /auth/me, so a module
// would disappear here even without the first check. The check is explicit anyway, because a screen with
// no permission requirement (`any: []`) would otherwise stay visible to a client that never bought it.
export const MODULES = [
  { key: 'dashboard', path: '/', label: 'Dashboard', any: [], module: null },
  { key: 'journeys', cp: 'CP-04', path: '/journeys', label: 'Journeys', any: ['journeys.read', 'journeys.read_all'], module: 'journeys' },
  { key: 'attendance', cp: 'CP-05', path: '/attendance', label: 'Attendance', any: ['attendance.submit', 'attendance.read'], module: 'attendance' },
  { key: 'inspections', cp: 'CP-06', path: '/inspections', label: 'Coach inspection', any: ['inspections.submit', 'inspections.read'], module: 'inspections' },
  { key: 'feedback', cp: 'CP-07/CP-08', path: '/feedback', label: 'Feedback', any: ['feedback.collect', 'feedback.railway.submit', 'feedback.read'], module: 'feedback' },
  { key: 'complaints', cp: 'CP-09', path: '/complaints', label: 'Complaints', any: ['complaints.create', 'complaints.read'], module: 'complaints' },
  { key: 'inventory', cp: 'CP-10', path: '/inventory', label: 'Inventory', any: ['inventory.read', 'inventory.transact'], module: 'inventory' },
  {
    key: 'masters', cp: 'CP-03', path: '/masters', label: 'Master data', module: 'masters',
    any: ['trains.manage', 'users.read', 'divisions.manage', 'questions.manage', 'complaints.masters.manage', 'inventory.items.manage', 'policies.manage', 'clients.read'],
  },
  { key: 'reports', cp: 'CP-11', path: '/reports', label: 'Reports', any: ['reports.read'], module: 'reports' },
  // Everyone's own profile and password; reached from the menu, not listed with the modules.
  { key: 'profile', path: '/profile', label: 'User Profile', any: [], menuOnly: true, module: null },
  { key: 'security', path: '/security', label: 'Security status', any: [], menuOnly: true, module: null },
];

// `modules`: the client's module list from /auth/me (`me.client.modules`), or null when there is none to
// apply -- a Super Admin, who works across every client, and demo mode. Null means "do not gate".
export const moduleAllowed = (m, modules) => !m.module || !modules || modules.includes(m.module);

export const visibleModules = (can, modules = null) =>
  MODULES.filter((m) => moduleAllowed(m, modules) && (!m.any.length || m.any.some(can)));

// `parts`: the hash path split on '/'. Returns the module for the first segment, whether the user may
// open it, and the remaining segments for the module's own sub-routes.
export function resolveRoute(parts, can, modules = null) {
  const section = parts[0] ?? '';
  const module = MODULES.find((m) => m.path === `/${section}`) ?? null;
  return { module, allowed: !!module && visibleModules(can, modules).includes(module), rest: parts.slice(1) };
}

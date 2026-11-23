// How one permission resolves for one role in one division, from the grant rows the Role rights page loads:
// the division's override, else the office's, else the global grant. Mirrors role_grants() in
// backend/app/security/principal.py. Pure, so it is tested without rendering (tests/unit/roleRights.test.js).
//
// Returns { allowed, base, inOffice, office, division }: `base` is the global default, `inOffice` what the
// office makes of it, `allowed` the final answer; `office` / `division` are the override rows, if any.
export function resolve(code, roleId, grants) {
  const mine = (g) => g.role_id === roleId && g.permission_code === code;
  const global = grants.find((g) => mine(g) && !g.client_id && !g.division_id);
  const office = grants.find((g) => mine(g) && g.client_id && !g.division_id) ?? null;
  const division = grants.find((g) => mine(g) && g.division_id) ?? null;
  const base = global?.effect === 'allow';
  const inOffice = office ? office.effect === 'allow' : base;
  const allowed = division ? division.effect === 'allow' : inOffice;
  return { allowed, base, inOffice, office, division };
}

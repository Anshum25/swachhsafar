// How one permission resolves for one role in one division, from the grant rows the Role rights page loads:
// the division's override, else the one for every division of its kind (headquarters or station) in its
// office, else the office's, else the global grant. Mirrors role_grants() in backend/app/security/principal.py.
// Pure, so it is tested without rendering (tests/unit/roleRights.test.js).
//
// `kind`: the division's kind ('headquarters' | 'station'); rows for the other kind are ignored.
// Returns { allowed, base, inOffice, inKind, office, kindRow, division }: `base` is the global default,
// `inOffice` what the office makes of it, `inKind` what the headquarters/station rule makes of that, and
// `allowed` the final answer; `office` / `kindRow` / `division` are the override rows, if any.
export function resolve(code, roleId, grants, kind = null) {
  const mine = (g) => g.role_id === roleId && g.permission_code === code;
  const global = grants.find((g) => mine(g) && !g.client_id && !g.division_id);
  const office = grants.find((g) => mine(g) && g.client_id && !g.division_kind && !g.division_id) ?? null;
  const kindRow = kind ? grants.find((g) => mine(g) && g.client_id && g.division_kind === kind) ?? null : null;
  const division = grants.find((g) => mine(g) && g.division_id) ?? null;
  const base = global?.effect === 'allow';
  const inOffice = office ? office.effect === 'allow' : base;
  const inKind = kindRow ? kindRow.effect === 'allow' : inOffice;
  const allowed = division ? division.effect === 'allow' : inKind;
  return { allowed, base, inOffice, inKind, office, kindRow, division };
}

// Role rights: which permissions each role holds, and the per-office and per-division overrides on top.
// Backend: GET /roles, GET /permissions, GET/PUT/DELETE /permissions/grants (app/api/v1/org.py).
//
// How a right is decided, which is the thing to understand before changing anything here:
//
//   1. the global grant for the role          — the default, the same in every office
//   2. an override row for the office          — allow or deny for every division of that office
//   3. a row for every station (or every HQ)    — of that office; wins over the office row
//   4. an override row for this division      — allow or deny, and it wins over all of the above
//   5. the client's module subscription        — an unsubscribed module removes the right entirely
//
// So a permission shown as "Allowed" here can still be absent from a user's session, because the office
// has not bought that module. The column says so rather than leaving it a mystery.
//
// Super Admin is not listed: its grants are fixed, so that one account can always repair the others.
import { useMemo, useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { Badge, DataState, ErrorNote, Panel, Select, Tabs } from '../../../components/ui.jsx';
import { ConfirmDialog, useSave } from './common.jsx';
import { resolve } from './roleRights.js';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';

const SUPER_ADMIN_ROLE = 1;
const ADMIN_ROLE = 2;

// How each module's permissions are grouped for reading, and which client module gates them. `null`
// gates nothing (the platform). Mirrors app/security/catalog.py.
const MODULE_LABEL = {
  admin: 'Administration', users: 'Users', masters: 'Master data', journeys: 'Journeys',
  attendance: 'Attendance', inspections: 'Coach inspection', feedback: 'Feedback',
  complaints: 'Complaints', inventory: 'Inventory', reports: 'Reports', media: 'Media',
};
const ALWAYS_ON = new Set(['admin', 'users', 'masters', 'media', 'journeys']);

const EFFECT = { allow: { tone: 'green', text: 'Allowed' }, deny: { tone: 'red', text: 'Denied' } };

const SCOPE_TEXT = { office: 'this office', station: 'all stations', headquarters: 'all headquarters', division: 'this division' };

function Override({ row, inherited, scope, editable, onChange, code }) {
  if (!editable) return <span className="text-sm text-muted">{row ? EFFECT[row.effect].text : 'Inherited'}</span>;
  return (
    <Select
      value={row ? row.effect : 'inherit'}
      aria-label={`Override for ${code} in ${SCOPE_TEXT[scope]}`}
      onChange={onChange}
      options={[
        { value: 'inherit', label: `Inherit (${inherited ? 'allowed' : 'not granted'})` },
        { value: 'allow', label: `Allow in ${SCOPE_TEXT[scope]}` },
        { value: 'deny', label: `Deny in ${SCOPE_TEXT[scope]}` },
      ]}
    />
  );
}

function PermissionRow({ perm, roleId, grants, scope, showOffice, showDivision, kind, subscribed, canEdit, onChange }) {
  const state = resolve(perm.code, roleId, grants, kind);
  const gated = perm.module && !ALWAYS_ON.has(perm.module) && subscribed && !subscribed.includes(perm.module);

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-3">
        <span className="font-medium">{perm.code}</span>
        <span className="block text-xs text-muted">{perm.description}</span>
      </td>
      <td className="py-2 pr-3 text-center">
        <Badge tone={state.base ? 'green' : 'slate'}>{state.base ? 'Allowed' : 'Not granted'}</Badge>
      </td>
      {showOffice && (
        <td className="py-2 pr-3">
          <Override row={state.office} inherited={state.base} scope="office" code={perm.code}
            editable={canEdit && scope === 'office'} onChange={(v) => onChange(perm, v)} />
        </td>
      )}
      {showOffice && kind && (
        <td className="py-2 pr-3">
          <Override row={state.kindRow} inherited={state.inOffice} scope={kind} code={perm.code}
            editable={canEdit && scope === kind} onChange={(v) => onChange(perm, v)} />
        </td>
      )}
      {showDivision && (
        <td className="py-2 pr-3">
          <Override row={state.division} inherited={state.inKind} scope="division" code={perm.code}
            editable={canEdit && scope === 'division'} onChange={(v) => onChange(perm, v)} />
        </td>
      )}
      <td className="py-2 text-center">
        {gated
          ? <Badge tone="amber">Module off</Badge>
          : <Badge tone={state.allowed ? 'green' : 'slate'}>{state.allowed ? 'Allowed' : 'No'}</Badge>}
      </td>
    </tr>
  );
}

// `clientId` / `clientName`: the office the division belongs to. Without it (division rows read from the
// device's own database carry no office) the page offers the division scope only, as it always did.
// `modules`: the office's subscribed modules, when the page knows them (an office's own page does); else
// the signed-in user's office's. `divisionId` may be absent for an office with no headquarters or stations
// yet: then only office-wide rights can be set.
export default function RolePermissions({ divisionId, divisionName, clientId, clientName, divisionKind, modules }) {
  const { api, can, me, client } = useSession();
  const online = useNetworkStatus();
  const roles = useResource('/roles');
  const permissions = useResource('/permissions');
  // Global grants, this office's overrides and this division's, in one list.
  const globals = useResource('/permissions/grants');
  const officeRows = useResource(clientId ? '/permissions/grants' : null, clientId ? { client_id: clientId } : null);
  const overrides = useResource(divisionId ? '/permissions/grants' : null, divisionId ? { division_id: divisionId } : null);
  const [roleId, setRoleId] = useState(3); // Manager: the role most often adjusted
  const [scopeChoice, setScope] = useState(divisionId ? 'division' : 'office');
  const [pending, setPending] = useState(null);
  const canEdit = can('permissions.manage') && online;
  // Office-wide rows: Super Admin, or this office's own Admin (services/org.py _require_grant_scope).
  const roleOfMe = me?.user?.role_id;
  const canEditOffice = canEdit && !!clientId
    && (roleOfMe === SUPER_ADMIN_ROLE || (roleOfMe === ADMIN_ROLE && client?.id === clientId));
  const showOffice = !!clientId;
  const kind = divisionKind ?? null;
  const kindPlural = kind === 'headquarters' ? 'headquarters' : 'stations';
  const showDivision = !!divisionId;
  // Without a division there is nothing but the office to set rights for.
  const scope = canEditOffice ? (showDivision || scopeChoice === 'office' ? scopeChoice : 'office') : 'division';
  const subscribed = modules ?? client?.modules ?? null;
  const officeLabel = clientName || client?.name || 'this office';

  const grants = useMemo(() => {
    const g = (globals.data ?? []).filter((r) => !r.client_id && !r.division_id);
    const c = (officeRows.data ?? []).filter((r) => r.client_id === clientId);
    const d = (overrides.data ?? []).filter((r) => r.division_id);
    return [...g, ...c, ...d];
  }, [globals.data, officeRows.data, overrides.data, clientId]);

  const save = useSave(() => {
    setPending(null);
    globals.reload();
    officeRows.reload();
    overrides.reload();
  });

  const apply = (perm, choice) => setPending({ perm, choice, scope });

  const commit = () => {
    const { perm, choice, scope: at } = pending;
    const state = resolve(perm.code, roleId, grants, kind);
    const existing = at === 'office' ? state.office : at === 'division' ? state.division : state.kindRow;
    save.run(async () => {
      if (choice === 'inherit') {
        if (existing) await api.del(`/permissions/grants/${existing.id}`);
        return;
      }
      // PUT, not POST: the backend upserts the (role, permission, office or division) row (api/v1/org.py).
      await api.put('/permissions/grants', {
        role_id: roleId, permission_code: perm.code, effect: choice,
        ...(at === 'office' ? { client_id: clientId }
          : at === 'division' ? { division_id: divisionId }
            : { client_id: clientId, division_kind: at }),
      });
    }, `${perm.code} updated for ${SCOPE_TEXT[at]}.`);
  };

  const byModule = useMemo(() => {
    const list = (permissions.data ?? []).filter((p) => p.code !== 'permissions.manage' || roleId !== SUPER_ADMIN_ROLE);
    const groups = new Map();
    for (const p of list) {
      if (!groups.has(p.module)) groups.set(p.module, []);
      groups.get(p.module).push(p);
    }
    return [...groups.entries()].sort((a, b) => (MODULE_LABEL[a[0]] ?? a[0]).localeCompare(MODULE_LABEL[b[0]] ?? b[0]));
  }, [permissions.data, roleId]);

  if (!me || me.user.role_id > 2) {
    return <Panel title="Role rights"><p className="text-sm text-muted">Only an administrator can view role rights.</p></Panel>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        What each role may do. The default applies in every office. An office override applies in every division
        of <strong>{officeLabel}</strong>
        {showDivision
          ? <>; a station or headquarters rule applies to every one of that type in the office; a division
            override applies only in <strong>{divisionName || 'this division'}</strong> and wins over all of them.</>
          : '. Add a headquarters or station to this office to set rights for it alone.'}
        {' '}A right whose module the office has not subscribed to is off whatever this says.
      </p>

      {canEditOffice && (
        <div className="space-y-1 text-sm">
          <span className="font-semibold text-ink">Change rights for</span>
          <Tabs value={scope} onChange={setScope} tabs={[
            { value: 'office', label: `Whole office (${officeLabel})` },
            ...(kind ? [{ value: kind, label: `All ${kindPlural} of the office` }] : []),
            ...(showDivision ? [{ value: 'division', label: `This division (${divisionName || 'division'})` }] : []),
          ]} />
        </div>
      )}

      <DataState res={roles}>
        {(roleRows) => (
          <Tabs
            value={String(roleId)}
            onChange={(v) => setRoleId(Number(v))}
            tabs={roleRows.filter((r) => r.id !== SUPER_ADMIN_ROLE).map((r) => ({ value: String(r.id), label: r.name }))}
          />
        )}
      </DataState>

      {!canEdit && (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {online ? 'You can see these rights but not change them.' : 'Offline — changing role rights needs a connection.'}
        </p>
      )}
      <ErrorNote error={save.error} />

      <DataState res={permissions}>
        {() => (
          <div className="space-y-3">
            {byModule.map(([module, perms]) => (
              <Panel key={module} title={MODULE_LABEL[module] ?? module}
                actions={!ALWAYS_ON.has(module) && subscribed && !subscribed.includes(module)
                  ? <Badge tone="amber">Not subscribed</Badge>
                  : null}>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                        <th className="py-2 pr-3">Permission</th>
                        <th className="py-2 pr-3 text-center">Default</th>
                        {showOffice && <th className="py-2 pr-3">In this office</th>}
                        {showOffice && kind && <th className="py-2 pr-3">At all {kindPlural}</th>}
                        {showDivision && <th className="py-2 pr-3">In this division</th>}
                        <th className="py-2 text-center">Effective</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perms.map((perm) => (
                        <PermissionRow key={perm.code} perm={perm} roleId={roleId} grants={grants} scope={scope}
                          showOffice={showOffice} showDivision={showDivision} kind={kind} subscribed={subscribed}
                          canEdit={canEdit} onChange={apply} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))}
          </div>
        )}
      </DataState>

      <ConfirmDialog
        open={!!pending}
        busy={save.busy}
        error={save.error}
        title="Change a role's rights"
        confirmLabel="Change it"
        onClose={() => { setPending(null); save.setError(null); }}
        message={pending
          ? `${pending.perm.code} will be ${pending.choice === 'inherit' ? 'inherited again' : `${pending.choice === 'allow' ? 'allowed' : 'denied'}`} for this role in ${pending.scope === 'office' ? `every division of ${officeLabel}` : pending.scope === 'division' ? (divisionName || 'this division') : `all ${kindPlural} of ${officeLabel}`}. It takes effect the next time those users' devices reach the server.`
          : ''}
        onConfirm={commit}
      />
    </div>
  );
}

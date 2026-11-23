// Role rights: which permissions each role holds, and the per-division overrides on top of them.
// Backend: GET /roles, GET /permissions, GET/POST/DELETE /permissions/grants (app/api/v1/org.py).
//
// How a right is decided, which is the thing to understand before changing anything here:
//
//   1. the global grant for the role          — the default, the same in every division
//   2. an override row for this division      — allow or deny, and it wins over the global grant
//   3. the client's module subscription        — an unsubscribed module removes the right entirely
//
// So a permission shown as "Allowed" here can still be absent from a user's session, because the office
// has not bought that module. The column says so rather than leaving it a mystery.
//
// Super Admin is not listed: its grants are fixed, so that one account can always repair the others.
import { useMemo, useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { Badge, DataState, ErrorNote, Panel, Select, Tabs } from '../../../components/ui.jsx';
import { ConfirmDialog, useSave } from './common.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';

const SUPER_ADMIN_ROLE = 1;

// How each module's permissions are grouped for reading, and which client module gates them. `null`
// gates nothing (the platform). Mirrors app/security/catalog.py.
const MODULE_LABEL = {
  admin: 'Administration', users: 'Users', masters: 'Master data', journeys: 'Journeys',
  attendance: 'Attendance', inspections: 'Coach inspection', feedback: 'Feedback',
  complaints: 'Complaints', inventory: 'Inventory', reports: 'Reports', media: 'Media',
};
const ALWAYS_ON = new Set(['admin', 'users', 'masters', 'media', 'journeys']);

const EFFECT = { allow: { tone: 'green', text: 'Allowed' }, deny: { tone: 'red', text: 'Denied' } };

// The effective state of one permission for one role in one division.
function resolve(code, roleId, grants) {
  const global = grants.find((g) => g.role_id === roleId && g.permission_code === code && !g.division_id);
  const override = grants.find((g) => g.role_id === roleId && g.permission_code === code && g.division_id);
  const base = global?.effect === 'allow';
  if (override) return { allowed: override.effect === 'allow', source: 'division', override, base };
  return { allowed: base, source: global ? 'global' : 'none', override: null, base };
}

function PermissionRow({ perm, roleId, grants, divisionId, subscribed, canEdit, onChange }) {
  const state = resolve(perm.code, roleId, grants);
  const gated = perm.module && !ALWAYS_ON.has(perm.module) && subscribed && !subscribed.includes(perm.module);
  const value = state.override ? state.override.effect : 'inherit';

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-3">
        <span className="font-medium">{perm.code}</span>
        <span className="block text-xs text-muted">{perm.description}</span>
      </td>
      <td className="py-2 pr-3 text-center">
        <Badge tone={state.base ? 'green' : 'slate'}>{state.base ? 'Allowed' : 'Not granted'}</Badge>
      </td>
      <td className="py-2 pr-3">
        {canEdit ? (
          <Select
            value={value}
            aria-label={`Override for ${perm.code}`}
            onChange={(v) => onChange(perm, v)}
            options={[
              { value: 'inherit', label: `Use default (${state.base ? 'allowed' : 'not granted'})` },
              { value: 'allow', label: 'Allow in this division' },
              { value: 'deny', label: 'Deny in this division' },
            ]}
          />
        ) : (
          <span className="text-sm text-muted">{state.override ? EFFECT[state.override.effect].text : 'Default'}</span>
        )}
      </td>
      <td className="py-2 text-center">
        {gated
          ? <Badge tone="amber">Module off</Badge>
          : <Badge tone={state.allowed ? 'green' : 'slate'}>{state.allowed ? 'Allowed' : 'No'}</Badge>}
      </td>
    </tr>
  );
}

export default function RolePermissions({ divisionId, divisionName }) {
  const { api, can, me, client } = useSession();
  const online = useNetworkStatus();
  const roles = useResource('/roles');
  const permissions = useResource('/permissions');
  // Global grants and this division's overrides, in one list.
  const globals = useResource('/permissions/grants');
  const overrides = useResource('/permissions/grants', divisionId ? { division_id: divisionId } : null);
  const [roleId, setRoleId] = useState(3); // Manager: the role most often adjusted
  const [pending, setPending] = useState(null);
  const canEdit = can('permissions.manage') && online;
  const subscribed = client?.modules ?? null;

  const grants = useMemo(() => {
    const g = globals.data ?? [];
    const o = (overrides.data ?? []).filter((r) => r.division_id);
    return [...g.filter((r) => !r.division_id), ...o];
  }, [globals.data, overrides.data]);

  const save = useSave(() => {
    setPending(null);
    globals.reload();
    overrides.reload();
  });

  const apply = (perm, choice) => setPending({ perm, choice });

  const commit = () => {
    const { perm, choice } = pending;
    const state = resolve(perm.code, roleId, grants);
    save.run(async () => {
      if (choice === 'inherit') {
        if (state.override) await api.del(`/permissions/grants/${state.override.id}`);
        return;
      }
      // PUT, not POST: the backend upserts the (role, permission, division) row (api/v1/org.py).
      await api.put('/permissions/grants', {
        role_id: roleId, permission_code: perm.code, division_id: divisionId, effect: choice,
      });
    }, `${perm.code} updated for this division.`);
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
        What each role may do. The default applies in every division; an override applies only in
        <strong> {divisionName || 'this division'}</strong>. A right whose module the office has not
        subscribed to is off whatever this says.
      </p>

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
                        <th className="py-2 pr-3">In this division</th>
                        <th className="py-2 text-center">Effective</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perms.map((perm) => (
                        <PermissionRow key={perm.code} perm={perm} roleId={roleId} grants={grants}
                          divisionId={divisionId} subscribed={subscribed} canEdit={canEdit} onChange={apply} />
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
          ? `${pending.perm.code} will be ${pending.choice === 'inherit' ? 'left at its default' : `${pending.choice === 'allow' ? 'allowed' : 'denied'}`} for this role in ${divisionName || 'this division'}. It takes effect the next time those users' devices reach the server.`
          : ''}
        onConfirm={commit}
      />
    </div>
  );
}

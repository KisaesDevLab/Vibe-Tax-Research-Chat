// Phase 4 — admin user management.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../lib/api';

interface AdminUserRow {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'user' | 'viewer';
  is_active: boolean;
  monthly_spend_cap_usd: string | null;
  last_login_at: string | null;
}

export function AdminUsersPage() {
  const qc = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [setPwFor, setSetPwFor] = useState<AdminUserRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetSentFor, setResetSentFor] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<{ users: AdminUserRow[] }>({
    queryKey: ['admin', 'users'],
    queryFn: () => api('/api/admin/users'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setEditing(null);
    },
    onError: (e) => setError(humanizeError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
    onError: (e) => setError(humanizeError(e)),
  });

  const sendReset = useMutation({
    mutationFn: (id: string) => api(`/api/admin/users/${id}/send-reset`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      const u = data?.users.find((x) => x.id === id);
      if (u) {
        setError(null);
        setResetSentFor(u.email);
        window.setTimeout(() => setResetSentFor(null), 5000);
      }
    },
    onError: (e) => setError(humanizeError(e)),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Users</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refetch()}
            className="px-3 py-1.5 border border-ink/20 rounded text-sm"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowInvite(true)}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm"
          >
            Invite user
          </button>
        </div>
      </div>

      {error && (
        <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-sm rounded p-3 mb-4 flex items-baseline justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="underline whitespace-nowrap">
            Dismiss
          </button>
        </div>
      )}
      {resetSentFor && (
        <div className="border border-moss/40 bg-moss/5 text-moss text-sm rounded p-3 mb-4">
          Reset email sent to <span className="font-mono">{resetSentFor}</span>.
        </div>
      )}

      {isLoading && <div>Loading…</div>}
      {data && data.users.length === 0 && (
        <div className="text-sm text-ink/50">No users yet — invite the first one.</div>
      )}
      {data && data.users.length > 0 && (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-ink/50 border-b border-ink/10">
              <th className="py-2">Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Cap (USD/mo)</th>
              <th>Last login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id} className="border-b border-ink/5">
                <td className="py-2 font-mono text-xs">{u.email}</td>
                <td>{u.display_name}</td>
                <td>{u.role}</td>
                <td>{u.is_active ? 'active' : 'disabled'}</td>
                <td className="font-mono text-xs">{u.monthly_spend_cap_usd ?? '—'}</td>
                <td className="font-mono text-xs">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
                </td>
                <td>
                  <div className="flex gap-3 justify-end whitespace-nowrap">
                    <button onClick={() => setEditing(u)} className="text-xs underline">
                      edit
                    </button>
                    <button
                      onClick={() => sendReset.mutate(u.id)}
                      disabled={sendReset.isPending || !u.is_active}
                      className="text-xs underline disabled:opacity-40 disabled:no-underline"
                      title={u.is_active ? 'Email a reset link to this user' : 'User is disabled'}
                    >
                      send reset
                    </button>
                    <button onClick={() => setSetPwFor(u)} className="text-xs underline">
                      set password
                    </button>
                    {u.is_active ? (
                      <button
                        onClick={() => patch.mutate({ id: u.id, body: { is_active: false } })}
                        className="text-xs underline text-oxblood"
                      >
                        disable
                      </button>
                    ) : (
                      <button
                        onClick={() => patch.mutate({ id: u.id, body: { is_active: true } })}
                        className="text-xs underline text-moss"
                      >
                        enable
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (
                          confirm(
                            `Delete ${u.email}? This soft-deletes the user and revokes their access.`,
                          )
                        ) {
                          remove.mutate(u.id);
                        }
                      }}
                      className="text-xs underline text-oxblood"
                    >
                      delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showInvite && <InviteModal onClose={() => setShowInvite(false)} onError={setError} />}
      {editing && (
        <EditModal
          user={editing}
          onClose={() => setEditing(null)}
          onSave={(body) => patch.mutate({ id: editing.id, body })}
          busy={patch.isPending}
        />
      )}
      {setPwFor && (
        <SetPasswordModal user={setPwFor} onClose={() => setSetPwFor(null)} onError={setError} />
      )}
    </div>
  );
}

function humanizeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.message === 'last_admin_protected')
      return 'Cannot remove the last active admin — promote another user to admin first.';
    if (e.message === 'cannot_delete_self') return 'Cannot delete your own account.';
    if (e.message === 'cannot_demote_self') return 'Cannot demote your own admin role.';
    if (e.message === 'cannot_disable_self') return 'Cannot disable your own account.';
    if (e.message === 'email_not_configured')
      return 'Configure SMTP or Resend on the Settings page before sending reset emails.';
    if (e.message === 'user_inactive')
      return 'User is disabled; enable them before sending a reset.';
    return e.message;
  }
  return (e as Error).message;
}

function InviteModal({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user' | 'viewer'>('user');

  const create = useMutation({
    mutationFn: () =>
      api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, display_name: name, password, role }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      onClose();
    },
    onError: (e) => onError(humanizeError(e)),
  });

  return (
    <div className="fixed inset-0 bg-ink/40 grid place-items-center">
      <div className="bg-paper p-6 rounded w-[420px] border border-ink/10">
        <h2 className="font-display text-xl mb-4">Invite user</h2>
        <div className="space-y-3">
          <input
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            type="email"
            autoComplete="off"
          />
          <input
            placeholder="display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
          />
          <input
            type="password"
            placeholder="initial password (≥ 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            autoComplete="new-password"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
            <option value="viewer">viewer</option>
          </select>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !email || !name || password.length < 8}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditModal({
  user,
  onClose,
  onSave,
  busy,
}: {
  user: AdminUserRow;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(user.display_name);
  const [role, setRole] = useState(user.role);
  const [cap, setCap] = useState(
    user.monthly_spend_cap_usd === null ? '' : String(user.monthly_spend_cap_usd),
  );

  function save() {
    const body: Record<string, unknown> = {};
    if (name !== user.display_name) body.display_name = name;
    if (role !== user.role) body.role = role;
    const trimmed = cap.trim();
    const newCap = trimmed === '' ? null : Number(trimmed);
    const oldCap = user.monthly_spend_cap_usd === null ? null : Number(user.monthly_spend_cap_usd);
    if (newCap !== oldCap) body.monthly_spend_cap_usd = newCap;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    onSave(body);
  }

  return (
    <div className="fixed inset-0 bg-ink/40 grid place-items-center">
      <div className="bg-paper p-6 rounded w-[420px] border border-ink/10">
        <h2 className="font-display text-xl mb-1">Edit user</h2>
        <div className="text-xs text-ink/50 font-mono mb-4">{user.email}</div>
        <div className="space-y-3">
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">Display name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
            />
          </label>
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">Role</div>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">
              Monthly spend cap (USD, blank = none)
            </div>
            <input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="e.g. 50"
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              inputMode="decimal"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SetPasswordModal({
  user,
  onClose,
  onError,
}: {
  user: AdminUserRow;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const setPwd = useMutation({
    mutationFn: () =>
      api(`/api/admin/users/${user.id}/set-password`, {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      }),
    onSuccess: () => onClose(),
    onError: (e) => onError(humanizeError(e)),
  });
  const ok = pw.length >= 8 && pw === pw2;

  return (
    <div className="fixed inset-0 bg-ink/40 grid place-items-center">
      <div className="bg-paper p-6 rounded w-[420px] border border-ink/10">
        <h2 className="font-display text-xl mb-1">Set password</h2>
        <div className="text-xs text-ink/50 font-mono mb-4">{user.email}</div>
        <div className="space-y-3">
          <input
            type="password"
            placeholder="new password (≥ 8 chars)"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="confirm password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            autoComplete="new-password"
          />
          {pw.length > 0 && pw !== pw2 && (
            <div className="text-xs text-oxblood">Passwords don&apos;t match.</div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={() => setPwd.mutate()}
            disabled={!ok || setPwd.isPending}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {setPwd.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

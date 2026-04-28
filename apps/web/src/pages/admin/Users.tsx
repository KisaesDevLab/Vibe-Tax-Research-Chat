// Phase 4 — admin user management.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';

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

  const { data, isLoading } = useQuery<{ users: AdminUserRow[] }>({
    queryKey: ['admin', 'users'],
    queryFn: () => api('/api/admin/users'),
  });

  const disable = useMutation({
    mutationFn: (id: string) =>
      api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active: false }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Users</h1>
        <button onClick={() => setShowInvite(true)} className="px-3 py-1.5 bg-ink text-paper rounded text-sm">
          Invite user
        </button>
      </div>

      {isLoading && <div>Loading…</div>}
      {data && (
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
                  {u.is_active && (
                    <button onClick={() => disable.mutate(u.id)} className="text-oxblood text-xs underline">
                      disable
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
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
          />
          <input
            placeholder="display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
          />
          <input
            type="password"
            placeholder="initial password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
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
            disabled={create.isPending}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { setToken, api } from '../api';

const ALL_GROUPS = [
  'system', 'tasks_read', 'tasks_write', 'worklogs_read', 'worklogs_write',
  'agents_read', 'agents_write', 'agents_admin',
  'escalation_read', 'escalation_write', 'escalation_admin',
  'webhook_read', 'webhook_admin',
  'scheduler_read', 'scheduler_admin',
  'cron_read', 'cron_admin',
];

const ALL_ALIASES = ['full', 'read_all', 'write_all', 'task_ops', 'task_readonly', 'supervisor'];

function AgentPermEditor({ agentId, groups, allOptions, onChange, onRemove }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const available = allOptions.filter(g => !groups.includes(g));

  function addItem(item) {
    onChange(agentId, [...groups, item]);
    setShowDropdown(false);
  }

  function removeItem(item) {
    onChange(agentId, groups.filter(g => g !== item));
  }

  return (
    <tr>
      <td style={{ verticalAlign: 'top', fontWeight: agentId === '*' ? 'bold' : 'normal' }}>
        <code>{agentId}</code>
        {agentId === '*' && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>default fallback</div>}
      </td>
      <td>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {groups.map(g => (
            <span key={g} className={`badge ${ALL_ALIASES.includes(g) ? 'badge-alias' : 'badge-group'}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {g}
              <span onClick={() => removeItem(g)} style={{ cursor: 'pointer', opacity: 0.6, fontWeight: 'bold' }}>&times;</span>
            </span>
          ))}
          {groups.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>no permissions</span>}
        </div>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <button className="btn btn-sm" onClick={() => setShowDropdown(!showDropdown)} disabled={available.length === 0}>+ Add</button>
          {showDropdown && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 100,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 6, padding: 4, maxHeight: 240, overflowY: 'auto', minWidth: 200,
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            }}>
              {ALL_ALIASES.filter(a => !groups.includes(a)).length > 0 && (
                <>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 8px', textTransform: 'uppercase' }}>Aliases</div>
                  {ALL_ALIASES.filter(a => !groups.includes(a)).map(a => (
                    <div key={a} onClick={() => addItem(a)}
                      style={{ padding: '4px 8px', cursor: 'pointer', borderRadius: 4, fontSize: 13 }}
                      onMouseEnter={e => e.target.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.target.style.background = 'transparent'}>
                      {a}
                    </div>
                  ))}
                  <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
                </>
              )}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 8px', textTransform: 'uppercase' }}>Groups</div>
              {ALL_GROUPS.filter(g => !groups.includes(g)).map(g => (
                <div key={g} onClick={() => addItem(g)}
                  style={{ padding: '4px 8px', cursor: 'pointer', borderRadius: 4, fontSize: 13 }}
                  onMouseEnter={e => e.target.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.target.style.background = 'transparent'}>
                  {g}
                </div>
              ))}
            </div>
          )}
        </div>
      </td>
      <td style={{ verticalAlign: 'top' }}>
        {agentId !== '*' && (
          <button className="btn btn-sm btn-danger" onClick={() => onRemove(agentId)} title="Remove agent permissions">
            &times;
          </button>
        )}
      </td>
    </tr>
  );
}

export default function Settings() {
  const { data: configData, loading, error, reload } = useApi('/config');
  const { data: healthData, reload: reloadHealth } = useApi('/config/health');
  const { data: permsData, reload: reloadPerms } = useApi('/config/permissions');
  const [token, setTokenVal] = useState(localStorage.getItem('openclaw_task_token') || '');
  const [saved, setSaved] = useState(false);

  // Permission editor state
  const [agentPerms, setAgentPerms] = useState(null); // null = not loaded
  const [permsDirty, setPermsDirty] = useState(false);
  const [permsSaving, setPermsSaving] = useState(false);
  const [permsMsg, setPermsMsg] = useState(null);
  const [newAgentId, setNewAgentId] = useState('');

  // Sync from API data
  useEffect(() => {
    if (permsData?.agentPermissions && agentPerms === null) {
      setAgentPerms({ ...permsData.agentPermissions });
    }
  }, [permsData]);

  function saveToken() {
    setToken(token);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  // Permission editor handlers
  function handlePermChange(agentId, newGroups) {
    setAgentPerms(prev => ({ ...prev, [agentId]: newGroups }));
    setPermsDirty(true);
    setPermsMsg(null);
  }

  function handlePermRemove(agentId) {
    setAgentPerms(prev => {
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
    setPermsDirty(true);
    setPermsMsg(null);
  }

  function handleAddAgent() {
    const id = newAgentId.trim();
    if (!id) return;
    if (agentPerms && agentPerms[id] !== undefined) {
      setPermsMsg({ type: 'error', text: `Agent "${id}" already exists` });
      return;
    }
    setAgentPerms(prev => ({ ...prev, [id]: [] }));
    setNewAgentId('');
    setPermsDirty(true);
    setPermsMsg(null);
  }

  async function savePermissions() {
    setPermsSaving(true);
    setPermsMsg(null);
    try {
      const res = await api.put('/config/permissions', { agentPermissions: agentPerms });
      setPermsDirty(false);
      setPermsMsg({ type: 'success', text: res.warning || 'Permissions saved and applied.' });
      reloadPerms();
    } catch (err) {
      setPermsMsg({ type: 'error', text: err.message });
    } finally {
      setPermsSaving(false);
    }
  }

  function resetPermissions() {
    if (permsData?.agentPermissions) {
      setAgentPerms({ ...permsData.agentPermissions });
    }
    setPermsDirty(false);
    setPermsMsg(null);
  }

  const allOptions = [...ALL_ALIASES, ...ALL_GROUPS];

  if (loading) return <div className="loading">Loading settings...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
        <button className="btn btn-sm" onClick={() => { reload(); reloadHealth(); reloadPerms(); }}>Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Auth Token */}
        <div className="card section">
          <div className="section-title">API Authentication</div>
          <div className="form-group">
            <label>Bearer Token</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="password" value={token} onChange={e => setTokenVal(e.target.value)} placeholder="Enter auth token..." />
              <button className="btn btn-primary btn-sm" onClick={saveToken}>{saved ? 'Saved!' : 'Save'}</button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Token is stored in localStorage and sent as Bearer header with all API requests.</div>
        </div>

        {/* Database Health */}
        <div className="card section">
          <div className="section-title">Database</div>
          {configData?.database ? (
            <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
              <div className="flex-between">
                <span>Connection</span>
                <span className={`badge badge-${configData.database.connected ? 'healthy' : 'unhealthy'}`}>
                  {configData.database.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <div className="flex-between"><span>Schema Version</span><strong>{configData.database.schema_version}</strong></div>
              {configData.database.pool && (
                <>
                  <div className="flex-between"><span>Pool Total</span><span>{configData.database.pool.total}</span></div>
                  <div className="flex-between"><span>Pool Idle</span><span>{configData.database.pool.idle}</span></div>
                  <div className="flex-between"><span>Pool Waiting</span><span>{configData.database.pool.waiting}</span></div>
                </>
              )}
            </div>
          ) : <div style={{ color: 'var(--text-muted)' }}>Unable to fetch database info</div>}
        </div>

        {/* System Health */}
        <div className="card section">
          <div className="section-title">System Health</div>
          {healthData ? (
            <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
              <div className="flex-between">
                <span>Status</span>
                <span className={`badge badge-${healthData.status}`}>{healthData.status}</span>
              </div>
              <div className="flex-between"><span>Total Tasks</span><strong>{healthData.task_count}</strong></div>
              <div className="flex-between"><span>Last Check</span><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{healthData.timestamp}</span></div>
            </div>
          ) : <div style={{ color: 'var(--text-muted)' }}>Loading...</div>}
        </div>

        {/* Plugin Info */}
        <div className="card section">
          <div className="section-title">Plugin Info</div>
          <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
            <div className="flex-between"><span>Name</span><strong>task-system</strong></div>
            <div className="flex-between"><span>Web UI Port</span><strong>18790</strong></div>
            <div className="flex-between"><span>Server Time</span><span style={{ fontSize: 12 }}>{configData?.timestamp || '—'}</span></div>
          </div>
        </div>
      </div>

      {/* ── Agent Permissions Editor ── */}
      <div className="card section mt-16">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}>Agent Permissions</div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>
              Assign permission groups and aliases to each agent. Changes apply immediately at runtime and are persisted to openclaw.json.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {permsDirty && <button className="btn btn-sm" onClick={resetPermissions}>Reset</button>}
            <button className="btn btn-primary btn-sm" onClick={savePermissions} disabled={!permsDirty || permsSaving}>
              {permsSaving ? 'Saving...' : 'Save Permissions'}
            </button>
          </div>
        </div>

        {permsMsg && (
          <div style={{
            padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
            background: permsMsg.type === 'error' ? 'rgba(255,80,80,0.15)' : 'rgba(80,200,120,0.15)',
            color: permsMsg.type === 'error' ? '#ff6b6b' : '#50c878',
          }}>
            {permsMsg.text}
          </div>
        )}

        {agentPerms ? (
          <>
            <table>
              <thead>
                <tr><th>Agent</th><th>Groups / Aliases</th><th style={{ width: 40 }}></th></tr>
              </thead>
              <tbody>
                {/* Always show * first if it exists */}
                {agentPerms['*'] !== undefined && (
                  <AgentPermEditor
                    agentId="*"
                    groups={agentPerms['*']}
                    allOptions={allOptions}
                    onChange={handlePermChange}
                    onRemove={handlePermRemove}
                  />
                )}
                {Object.keys(agentPerms).filter(k => k !== '*').sort().map(agentId => (
                  <AgentPermEditor
                    key={agentId}
                    agentId={agentId}
                    groups={agentPerms[agentId]}
                    allOptions={allOptions}
                    onChange={handlePermChange}
                    onRemove={handlePermRemove}
                  />
                ))}
              </tbody>
            </table>

            {/* Add new agent row */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input
                value={newAgentId}
                onChange={e => setNewAgentId(e.target.value)}
                placeholder="Agent ID (e.g. dispatch-agent)"
                style={{ flex: 1 }}
                onKeyDown={e => e.key === 'Enter' && handleAddAgent()}
              />
              <button className="btn btn-sm" onClick={handleAddAgent} disabled={!newAgentId.trim()}>+ Add Agent</button>
              {!agentPerms['*'] && (
                <button className="btn btn-sm" onClick={() => {
                  setAgentPerms(prev => ({ '*': ['system', 'tasks_read'], ...prev }));
                  setPermsDirty(true);
                }}>+ Add Default (*)</button>
              )}
            </div>
          </>
        ) : <div className="loading">Loading permissions...</div>}
      </div>

      {/* Permission Groups Reference */}
      <div className="card section mt-16">
        <div className="section-title">Permission Reference</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
          Available groups and aliases that can be assigned to agents above.
        </p>
        {permsData ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Groups</h3>
              <table>
                <thead><tr><th>Group</th><th>Tools</th></tr></thead>
                <tbody>
                  {(Array.isArray(permsData.groups) ? permsData.groups : Object.entries(permsData.groups || {}).map(([name, tools]) => ({ name, toolNames: tools }))).map(g => (
                    <tr key={g.name}>
                      <td><code>{g.name}</code></td>
                      <td style={{ fontSize: 11 }}>{Array.isArray(g.toolNames) ? g.toolNames.join(', ') : `${g.tools || 0} tools`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Aliases</h3>
              <table>
                <thead><tr><th>Alias</th><th>Expands To</th></tr></thead>
                <tbody>
                  {(Array.isArray(permsData.aliases) ? permsData.aliases : Object.entries(permsData.aliases || {}).map(([name, groups]) => ({ name, groups }))).map(a => (
                    <tr key={a.name}>
                      <td><code>{a.name}</code></td>
                      <td style={{ fontSize: 11 }}>{Array.isArray(a.groups) ? a.groups.join(', ') : String(a.groups || '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : <div className="loading">Loading permissions...</div>}
      </div>
    </div>
  );
}

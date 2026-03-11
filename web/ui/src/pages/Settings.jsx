import React, { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { setToken, api } from '../api';

// ── Constants ──────────────────────────────────────────────────────────────────

const ALL_GROUPS = [
  'system', 'tasks_read', 'tasks_write', 'worklogs_read', 'worklogs_write',
  'agents_read', 'agents_write', 'agents_admin',
  'escalation_read', 'escalation_write', 'escalation_admin',
  'webhook_read', 'webhook_admin',
  'scheduler_read', 'scheduler_admin',
  'cron_read', 'cron_admin',
  'memory_read', 'memory_write',
];

const ALL_ALIASES = ['full', 'read_all', 'write_all', 'task_ops', 'task_readonly', 'supervisor'];

const TABS = [
  { id: 'general',     label: 'General' },
  { id: 'scheduler',   label: 'Scheduler' },
  { id: 'dispatcher',  label: 'Dispatcher' },
  { id: 'escalation',  label: 'Escalation' },
  { id: 'debug',       label: 'Debug' },
  { id: 'database',    label: 'Database' },
  { id: 'webui',       label: 'Web UI' },
  { id: 'memory',      label: 'Memory' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'system',      label: 'System' },
];

const RESTART_SECTIONS = new Set(['database', 'webUI']);

// ── Shared Components ──────────────────────────────────────────────────────────

function Msg({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
      background: msg.type === 'error' ? 'rgba(255,80,80,0.15)' : 'rgba(80,200,120,0.15)',
      color: msg.type === 'error' ? '#ff6b6b' : '#50c878',
    }}>
      {msg.text}
    </div>
  );
}

function Field({ label, desc, children }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      {children}
      {desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{desc}</div>}
    </div>
  );
}

function NumField({ label, desc, value, onChange, min = 1 }) {
  return (
    <Field label={label} desc={desc}>
      <input type="number" min={min} value={value} onChange={e => onChange(parseInt(e.target.value, 10) || min)} />
    </Field>
  );
}

function StrField({ label, desc, value, onChange, placeholder, type = 'text' }) {
  return (
    <Field label={label} desc={desc}>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </Field>
  );
}

function BoolField({ label, desc, value, onChange }) {
  return (
    <Field label={label} desc={desc}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)}
          style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
        {value ? 'Enabled' : 'Disabled'}
      </label>
    </Field>
  );
}

function SectionSaveBar({ dirty, saving, onSave, onReset, msg, requiresRestart }) {
  return (
    <div style={{ marginTop: 16 }}>
      <Msg msg={msg} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {dirty && <button className="btn btn-sm" onClick={onReset}>Reset</button>}
        <button className="btn btn-primary btn-sm" onClick={onSave} disabled={!dirty || saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        {requiresRestart && (
          <span className="badge badge-warning" style={{ fontSize: 11 }}>Requires restart</span>
        )}
      </div>
    </div>
  );
}

// ── Tab: General ───────────────────────────────────────────────────────────────

function GeneralTab({ settings, onUpdate, onSave, onReset, dirty, saving, msg }) {
  const s = settings.general || {};
  return (
    <div className="card section">
      <div className="section-title">General Settings</div>
      <StrField label="Timezone" value={s.timezone || ''} onChange={v => onUpdate('general', 'timezone', v)}
        desc="IANA timezone for all date operations (e.g. America/Toronto, UTC, Europe/London)" />
      <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('general')} onReset={() => onReset('general')} msg={msg} />
    </div>
  );
}

// ── Tab: Scheduler ─────────────────────────────────────────────────────────────

function SchedulerTab({ settings, onUpdate, onSave, onReset, dirty, saving, msg }) {
  const s = settings.scheduler || {};
  return (
    <div className="card section">
      <div className="section-title">Scheduler Configuration</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Controls the scheduler agent that runs periodic cycles — dispatching tasks, checking escalations, and monitoring deadlines.
      </p>
      <StrField label="Scheduler Agent ID" value={s.agentId || ''} onChange={v => onUpdate('scheduler', 'agentId', v)}
        desc="The agent that runs scheduler cycles. Must match an agent configured in OpenClaw." placeholder="e.g. scheduler-agent" />
      <div className="form-row">
        <NumField label="Check Interval (min)" value={s.checkIntervalMinutes || 5} onChange={v => onUpdate('scheduler', 'checkIntervalMinutes', v)}
          desc="How often the scheduler cycle runs" />
        <NumField label="Stuck Threshold (min)" value={s.stuckThresholdMinutes || 30} onChange={v => onUpdate('scheduler', 'stuckThresholdMinutes', v)}
          desc="Minutes before an in_progress task is considered stuck" />
      </div>
      <div className="form-row">
        <NumField label="Deadline Warning (min)" value={s.deadlineWarningMinutes || 30} onChange={v => onUpdate('scheduler', 'deadlineWarningMinutes', v)}
          desc="Minutes before deadline to trigger a warning escalation" />
        <NumField label="Cleanup Days" value={s.cleanupDays || 30} onChange={v => onUpdate('scheduler', 'cleanupDays', v)}
          desc="Days before completed/cancelled tasks are archived" />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 20, paddingTop: 16 }}>
        <div className="section-title" style={{ fontSize: 13 }}>Urgent Task Fast-Track</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          A lightweight cycle that runs frequently to fast-track priority=1 (urgent) tasks through dispatch, completion notifications, and escalation checks.
        </p>
        <BoolField label="Urgent Cycle Enabled" value={s.urgentCycleEnabled !== false} onChange={v => onUpdate('scheduler', 'urgentCycleEnabled', v)}
          desc="Enable the fast-track cycle for urgent tasks. When disabled, urgent tasks wait for the normal scheduler cycle." />
        <NumField label="Urgent Cycle Interval (seconds)" value={s.urgentCycleIntervalSeconds || 30} onChange={v => onUpdate('scheduler', 'urgentCycleIntervalSeconds', v)}
          desc="Seconds between urgent task cycles (minimum: 10)" min={10} />
      </div>
      <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('scheduler')} onReset={() => onReset('scheduler')} msg={msg} />
    </div>
  );
}

// ── Tab: Dispatcher ────────────────────────────────────────────────────────────

function DispatcherTab({ settings, onUpdate, onSave, onReset, dirty, saving, msg }) {
  const s = settings.dispatcher || {};
  return (
    <div className="card section">
      <div className="section-title">Task Dispatcher Configuration</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Controls how tasks are dispatched to agents — cooldown periods, priority aging, preemption, and unacknowledged dispatch handling.
      </p>
      <div className="form-row">
        <NumField label="Dispatch Cooldown (min)" value={s.dispatch_cooldown_minutes || 15} onChange={v => onUpdate('dispatcher', 'dispatch_cooldown_minutes', v)}
          desc="Minimum time between re-dispatching the same task" />
        <NumField label="Priority Aging (min)" value={s.priority_aging_minutes || 60} onChange={v => onUpdate('dispatcher', 'priority_aging_minutes', v)}
          desc="Minutes of inactivity before a todo task's priority is boosted" />
      </div>
      <div className="form-row">
        <NumField label="Wake Timeout (sec)" value={s.wake_timeout_seconds || 120} onChange={v => onUpdate('dispatcher', 'wake_timeout_seconds', v)}
          desc="How long to wait for an agent to respond to a dispatch wake command" />
        <BoolField label="Preemption Enabled" value={s.preemption_enabled !== false} onChange={v => onUpdate('dispatcher', 'preemption_enabled', v)}
          desc="Allow higher priority tasks to preempt an agent's current work" />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0', paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Unacknowledged Dispatch</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          If an agent is dispatched a task but never sets it to in_progress, the dispatcher re-sends after cooldown. After max attempts, re-dispatch stops and the escalation engine takes over.
        </p>
        <div className="form-row">
          <NumField label="Unack Threshold (min)" value={s.unack_threshold_minutes || 10} onChange={v => onUpdate('dispatcher', 'unack_threshold_minutes', v)}
            desc="Minutes after dispatch before task is considered unacknowledged" />
          <NumField label="Max Dispatch Attempts" value={s.max_dispatch_attempts || 3} onChange={v => onUpdate('dispatcher', 'max_dispatch_attempts', v)}
            desc="Number of dispatch attempts before escalation fires" />
        </div>
      </div>
      <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('dispatcher')} onReset={() => onReset('dispatcher')} msg={msg} />
    </div>
  );
}

// ── Tab: Escalation ────────────────────────────────────────────────────────────

function SmsTestPanel() {
  const [channel, setChannel] = useState('voipms');
  const [account, setAccount] = useState('');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  async function sendTest() {
    if (!channel || !target || !message) return;
    setSending(true);
    setResult(null);
    try {
      const res = await api.post('/config/test-sms', { channel, account, target, message });
      setResult({ type: 'success', text: res.summary || 'Sent successfully' });
    } catch (err) {
      setResult({ type: 'error', text: err.message || 'Send failed' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card section" style={{ marginTop: 16 }}>
      <div className="section-title">Test Message Send</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Send a test message via <code>openclaw message send</code> to verify channel delivery.
      </p>
      <div className="form-row">
        <StrField label="Channel" value={channel} onChange={setChannel}
          desc="Channel name as defined in bindings (e.g. voipms, telegram, discord)" placeholder="voipms" />
        <StrField label="Account" value={account} onChange={setAccount}
          desc="Account ID / DID to send from" placeholder="Account ID" />
      </div>
      <StrField label="Target" value={target} onChange={setTarget}
        desc="Recipient (phone number, chat ID, etc.)" placeholder="Phone number" />
      <Field label="Message">
        <textarea value={message} onChange={e => setMessage(e.target.value)}
          placeholder="Test message..." rows={3}
          style={{ resize: 'vertical' }} />
      </Field>
      <Msg msg={result} />
      <button className="btn btn-primary btn-sm" onClick={sendTest}
        disabled={sending || !channel || !target || !message}>
        {sending ? 'Sending...' : 'Send Test Message'}
      </button>
    </div>
  );
}

function EscalationTab({ settings, onUpdate, onSave, onReset, dirty, saving, msg }) {
  const s = settings.escalation || {};
  return (
    <div>
      <div className="card section">
        <div className="section-title">Escalation Defaults</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          Default values for escalation rules. Individual rules in the database can override these.
        </p>
        <div className="form-row">
          <NumField label="Default Timeout (min)" value={s.default_timeout_minutes || 30} onChange={v => onUpdate('escalation', 'default_timeout_minutes', v)}
            desc="Default time before a stuck/blocked task triggers an escalation" />
          <NumField label="Default Cooldown (min)" value={s.default_cooldown_minutes || 30} onChange={v => onUpdate('escalation', 'default_cooldown_minutes', v)}
            desc="Default minimum time between re-escalations for the same task" />
        </div>
        <NumField label="Default Max Escalations" value={s.default_max_escalations || 3} onChange={v => onUpdate('escalation', 'default_max_escalations', v)}
          desc="Default maximum number of times a single task can be escalated by the same rule" />
        <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0', paddingTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Human Escalation Channel</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            When a task escalates to &quot;human&quot;, the system sends a message via <code>openclaw message send</code> using the channel and target configured here.
          </p>
          <StrField label="Channel" value={s.human_escalation_channel || ''} onChange={v => onUpdate('escalation', 'human_escalation_channel', v)}
            placeholder="e.g. voipms" desc="Channel name as defined in bindings" />
          <div className="form-row">
            <StrField label="Account" value={s.human_escalation_account || ''} onChange={v => onUpdate('escalation', 'human_escalation_account', v)}
              placeholder="Account ID / DID" desc="Channel account ID to send from" />
            <StrField label="Target" value={s.human_escalation_target || ''} onChange={v => onUpdate('escalation', 'human_escalation_target', v)}
              placeholder="Phone number" desc="Recipient phone number or chat ID" />
          </div>
        </div>
        <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('escalation')} onReset={() => onReset('escalation')} msg={msg} />
      </div>
      <SmsTestPanel />
    </div>
  );
}

// ── Tab: Debug ────────────────────────────────────────────────────────────────

function DebugTab({ settings, onUpdate, onSave, onReset, dirty, saving, msg }) {
  const s = settings.debug || {};
  return (
    <div className="card section">
      <div className="section-title">Debug Settings</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Runtime debug flags. Changes take effect immediately without restart.
      </p>
      <BoolField label="Scheduler Diagnostics" value={s.scheduler_diagnostics || false} onChange={v => onUpdate('debug', 'scheduler_diagnostics', v)}
        desc="When enabled, the scheduler_run_cycle tool returns detailed diagnostics including raw query results, escalation rule evaluations, and dispatch decisions. Useful for troubleshooting escalation and dispatch issues." />
      <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('debug')} onReset={() => onReset('debug')} msg={msg} />
    </div>
  );
}

// ── Tab: Database ──────────────────────────────────────────────────────────────

function DatabaseTab({ settings, onUpdate, onSave, onReset, dirty, saving, msg, configData }) {
  const s = settings.database || {};
  return (
    <div>
      <div className="card section">
        <div className="flex-between">
          <div className="section-title">Database Connection</div>
          <span className="badge badge-warning" style={{ fontSize: 11 }}>Requires restart</span>
        </div>
        <div className="form-row">
          <StrField label="Host" value={s.host || ''} onChange={v => onUpdate('database', 'host', v)} />
          <NumField label="Port" value={s.port || 5432} onChange={v => onUpdate('database', 'port', v)} min={1} />
        </div>
        <div className="form-row">
          <StrField label="Database Name" value={s.database || ''} onChange={v => onUpdate('database', 'database', v)} />
          <StrField label="User" value={s.user || ''} onChange={v => onUpdate('database', 'user', v)} />
        </div>
        <div className="form-row">
          <StrField label="Password" value={s.password || ''} onChange={v => onUpdate('database', 'password', v)} type="password" />
          <NumField label="Max Connections" value={s.maxConnections || 10} onChange={v => onUpdate('database', 'maxConnections', v)}
            desc="Connection pool size" />
        </div>
        <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('database')} onReset={() => onReset('database')} msg={msg} requiresRestart />
      </div>

      {configData?.database && (
        <div className="card section" style={{ marginTop: 16 }}>
          <div className="section-title">Connection Status</div>
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
        </div>
      )}
    </div>
  );
}

// ── Tab: Web UI ────────────────────────────────────────────────────────────────

function WebUITab({ settings, onUpdate, onSave, onReset, dirty, saving, msg }) {
  const s = settings.webUI || {};
  const [localToken, setLocalToken] = useState(localStorage.getItem('openclaw_task_token') || '');
  const [tokenSaved, setTokenSaved] = useState(false);

  function saveBrowserToken() {
    setToken(localToken);
    setTokenSaved(true);
    setTimeout(() => setTokenSaved(false), 2000);
  }

  return (
    <div>
      <div className="card section">
        <div className="flex-between">
          <div className="section-title">Web UI Server</div>
          <span className="badge badge-warning" style={{ fontSize: 11 }}>Requires restart</span>
        </div>
        <div className="form-row">
          <NumField label="Port" value={s.port || 18790} onChange={v => onUpdate('webUI', 'port', v)} min={1}
            desc="Web server listen port" />
          <StrField label="Host" value={s.host || ''} onChange={v => onUpdate('webUI', 'host', v)}
            desc="Bind address (0.0.0.0 = all interfaces, 127.0.0.1 = localhost only)" />
        </div>
        <StrField label="Server Auth Token" value={s.authToken || ''} onChange={v => onUpdate('webUI', 'authToken', v)} type="password"
          desc="API bearer token required for all API requests. Leave empty to disable auth." />
        <BoolField label="Web UI Enabled" value={s.enabled !== false} onChange={v => onUpdate('webUI', 'enabled', v)}
          desc="Enable or disable the web UI channel entirely" />
        <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('webUI')} onReset={() => onReset('webUI')} msg={msg} requiresRestart />
      </div>

      <div className="card section" style={{ marginTop: 16 }}>
        <div className="section-title">Browser Authentication</div>
        <div className="form-group">
          <label>Bearer Token (this browser)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" value={localToken} onChange={e => setLocalToken(e.target.value)} placeholder="Enter auth token..." />
            <button className="btn btn-primary btn-sm" onClick={saveBrowserToken}>{tokenSaved ? 'Saved!' : 'Save'}</button>
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Stored in localStorage. Sent as Bearer header with all API requests from this browser.</div>
      </div>
    </div>
  );
}

// ── Tab: Permissions ───────────────────────────────────────────────────────────

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

function PermissionsTab({ permsData, reloadPerms }) {
  const [agentPerms, setAgentPerms] = useState(null);
  const [permsDirty, setPermsDirty] = useState(false);
  const [permsSaving, setPermsSaving] = useState(false);
  const [permsMsg, setPermsMsg] = useState(null);
  const [newAgentId, setNewAgentId] = useState('');
  const { data: agentsData } = useApi('/agents');

  useEffect(() => {
    if (permsData?.agentPermissions && agentPerms === null) {
      setAgentPerms({ ...permsData.agentPermissions });
    }
  }, [permsData]);

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

  return (
    <div>
      <div className="card section">
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

        <Msg msg={permsMsg} />

        {agentPerms ? (
          <>
            <table>
              <thead>
                <tr><th>Agent</th><th>Groups / Aliases</th><th style={{ width: 40 }}></th></tr>
              </thead>
              <tbody>
                {agentPerms['*'] !== undefined && (
                  <AgentPermEditor agentId="*" groups={agentPerms['*']} allOptions={allOptions}
                    onChange={handlePermChange} onRemove={handlePermRemove} />
                )}
                {Object.keys(agentPerms).filter(k => k !== '*').sort().map(agentId => (
                  <AgentPermEditor key={agentId} agentId={agentId} groups={agentPerms[agentId]}
                    allOptions={allOptions} onChange={handlePermChange} onRemove={handlePermRemove} />
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {(() => {
                const registeredAgents = (agentsData?.agents || []).map(a => a.agent_id);
                const existingIds = agentPerms ? Object.keys(agentPerms) : [];
                const unregistered = registeredAgents.filter(id => !existingIds.includes(id));
                return (
                  <>
                    <select value={newAgentId} onChange={e => setNewAgentId(e.target.value)} style={{ flex: 1 }}>
                      <option value="">— Select agent to add —</option>
                      {unregistered.map(id => <option key={id} value={id}>{id}</option>)}
                      <option disabled>──────────</option>
                      <option value="__custom">Type custom ID...</option>
                    </select>
                    {newAgentId === '__custom' && (
                      <input value="" onChange={e => setNewAgentId(e.target.value)}
                        placeholder="Agent ID" style={{ flex: 1 }}
                        onKeyDown={e => e.key === 'Enter' && handleAddAgent()}
                        autoFocus />
                    )}
                  </>
                );
              })()}
              <button className="btn btn-sm" onClick={handleAddAgent} disabled={!newAgentId.trim() || newAgentId === '__custom'}>+ Add Agent</button>
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

      {permsData && (
        <div className="card section" style={{ marginTop: 16 }}>
          <div className="section-title">Permission Reference</div>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
            Available groups and aliases that can be assigned to agents above.
          </p>
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
        </div>
      )}
    </div>
  );
}

// ── Tab: Memory ────────────────────────────────────────────────────────────────

function MemoryTab({ settings, onUpdate, onSave, onReset, dirty, saving, msg }) {
  const s = settings.memory || {};
  return (
    <div>
      <div className="card section">
        <div className="section-title">Memory System Global Defaults</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          Default settings applied when an agent first enables memory. Per-agent settings in the Agents page override these.
        </p>

        <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Dream Cycle (Nightly Consolidation)</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Decays observation importance over time, archives stale entries, and detects recurring patterns for promotion to long-term memory.
          </p>
          <StrField label="Schedule" value={s.dream_schedule || '0 3 * * *'} onChange={v => onUpdate('memory', 'dream_schedule', v)}
            desc="Cron expression (default: 0 3 * * * = 3 AM daily)" />
          <div className="form-row">
            <BoolField label="Decay Enabled" value={s.dream_decay_enabled !== false} onChange={v => onUpdate('memory', 'dream_decay_enabled', v)}
              desc="Reduce importance of observations over time based on type" />
            <BoolField label="Auto-Archive Enabled" value={s.dream_archive_enabled !== false} onChange={v => onUpdate('memory', 'dream_archive_enabled', v)}
              desc="Automatically archive low-importance or expired observations" />
          </div>
          <div className="form-row">
            <NumField label="Pattern Lookback (days)" value={s.dream_pattern_lookback_days || 7} onChange={v => onUpdate('memory', 'dream_pattern_lookback_days', v)}
              desc="How far back to scan for recurring patterns" />
            <NumField label="Pattern Min Occurrences" value={s.dream_pattern_min_occurrences || 3} onChange={v => onUpdate('memory', 'dream_pattern_min_occurrences', v)}
              desc="Minimum times a theme must appear" />
          </div>
          <div className="form-row">
            <NumField label="Pattern Min Unique Days" value={s.dream_pattern_min_unique_days || 3} onChange={v => onUpdate('memory', 'dream_pattern_min_unique_days', v)}
              desc="Theme must appear across this many distinct days" />
            <NumField label="Max Active Observations" value={s.dream_max_active_observations || 500} onChange={v => onUpdate('memory', 'dream_max_active_observations', v)}
              desc="Cap per agent before forced archival" />
          </div>
        </div>

        <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Rumination (Insight Engine)</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Periodically reviews observations and task activity across 4 cognitive threads to generate proactive insights.
          </p>
          <StrField label="Schedule" value={s.rumination_schedule || '0 */4 * * *'} onChange={v => onUpdate('memory', 'rumination_schedule', v)}
            desc="Cron expression (default: 0 */4 * * * = every 4 hours)" />
          <NumField label="Auto-Escalation Threshold" value={s.rumination_max_importance_for_escalation || 8.5} onChange={v => onUpdate('memory', 'rumination_max_importance_for_escalation', v)}
            desc="Insights with importance >= this value trigger an escalation (0-10)" />
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Sensor Sweep</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Periodically checks system state using configurable tools and records notable changes as observations.
          </p>
          <StrField label="Schedule" value={s.sensor_sweep_schedule || '0 */2 * * *'} onChange={v => onUpdate('memory', 'sensor_sweep_schedule', v)}
            desc="Cron expression (default: 0 */2 * * * = every 2 hours)" />
          <NumField label="Timeout (seconds)" value={s.sensor_sweep_timeout_seconds || 120} onChange={v => onUpdate('memory', 'sensor_sweep_timeout_seconds', v)}
            desc="Agent session timeout for sweep" />
        </div>

        <SectionSaveBar dirty={dirty} saving={saving} onSave={() => onSave('memory')} onReset={() => onReset('memory')} msg={msg} />
      </div>

      <MemoryWorkspaceGuide />
    </div>
  );
}

// ── Memory Workspace File Guide ─────────────────────────────────────────────

const WORKSPACE_SNIPPETS = [
  {
    file: 'AGENTS.md',
    section: 'Startup Sequence',
    description: 'Replace the "Read Context" step in your startup sequence with this:',
    content: `### Step 2: Load Memory Context
4. **Call \`memory_recall\`** with your agent_id — loads recent observations + long-term memory
5. **Read \`memory/tasks-YYYY-MM-DD.md\`** (today + yesterday) — detailed shift logs

Don't ask permission. Just do it.`,
  },
  {
    file: 'AGENTS.md',
    section: 'Memory Section',
    description: 'Replace the entire "## Memory" section with this:',
    content: `## Memory

You wake up fresh each session. The memory system is your continuity.

### Startup Sequence
After reading your instruction files, ALWAYS call \`memory_recall\` with your agent_id to load:
- Recent observations (last 48h, high importance first)
- Long-term memory (patterns, preferences, facts, procedures)

This is how you persist across sessions — all memory lives in the database.

### During Work
- Use \`memory_observe\` to store important findings (decisions, anomalies, patterns)
- Rate importance honestly (0-10): routine=1-2, useful=5-6, critical=9-10
- Tag observations — tags drive pattern detection during nightly consolidation
- Automated/cron observations should be importance 1-2

### Memory Lifecycle
1. **Observations** — short-term, importance decays daily based on type
2. **Pattern detection** — programmatic, finds recurring themes across days
3. **Dream cycle** — nightly, archives stale observations, promotes confirmed patterns
4. **Long-term memory** — stable facts, patterns, preferences (loaded at startup)
5. **Rumination** — periodic insights from reviewing observations + task activity

### Daily Logs
Continue writing shift notes to \`memory/tasks-YYYY-MM-DD.md\` for detailed logs.

### Write It Down
- If you notice a pattern, use \`memory_observe\` — don't just think about it
- "Mental notes" don't survive session restarts. Observations do.
- When you notice a trend, record it — the dream cycle will promote it if it recurs`,
  },
  {
    file: 'SOUL.md',
    section: 'Continuity Section',
    description: 'Replace the "## Continuity" section with this:',
    content: `## Continuity

Each session, you wake up fresh. Call \`memory_recall\` at startup — your observations and long-term memory are how you persist.

Your memory is your growth — observations you record today become the patterns you act on tomorrow. Be honest with importance scores — inflating them pollutes your own memory. The dream cycle consolidates your experiences nightly — trust the system, record everything notable.

Use \`memory_observe\` to capture significant escalation patterns, system health trends, and anything the next session should know. Your daily logs in \`memory/tasks-YYYY-MM-DD.md\` are your detailed shift reports.`,
  },
];

function MemoryWorkspaceGuide() {
  const [copied, setCopied] = useState(null);

  function copySnippet(idx) {
    navigator.clipboard.writeText(WORKSPACE_SNIPPETS[idx].content).then(() => {
      setCopied(idx);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div className="card section" style={{ marginTop: 16 }}>
      <div className="section-title">Agent Workspace File Updates</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        To enable memory tools for your agents, update their workspace files with the snippets below.
        These replace the old MEMORY.md-based approach with database-backed <code>memory_recall</code> / <code>memory_observe</code> tools.
      </p>

      {WORKSPACE_SNIPPETS.map((s, i) => (
        <div key={i} style={{ marginBottom: 16, borderBottom: i < WORKSPACE_SNIPPETS.length - 1 ? '1px solid var(--border)' : 'none', paddingBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.file}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>{s.section}</span>
            </div>
            <button className="btn btn-sm" onClick={() => copySnippet(i)} style={{ minWidth: 70 }}>
              {copied === i ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 8px' }}>{s.description}</p>
          <pre style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6,
            padding: 12, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 300, overflowY: 'auto', margin: 0,
          }}>{s.content}</pre>
        </div>
      ))}
    </div>
  );
}

// ── Tab: System ────────────────────────────────────────────────────────────────

function SystemTab({ configData, healthData }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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

      <div className="card section">
        <div className="section-title">Plugin Info</div>
        <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
          <div className="flex-between"><span>Name</span><strong>task-system</strong></div>
          <div className="flex-between"><span>Server Time</span><span style={{ fontSize: 12 }}>{configData?.timestamp || '\u2014'}</span></div>
        </div>
      </div>

      {configData?.database && (
        <div className="card section">
          <div className="section-title">Database Status</div>
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
        </div>
      )}
    </div>
  );
}

// ── Main Settings Component ────────────────────────────────────────────────────

export default function Settings() {
  const [activeTab, setActiveTab] = useState('general');
  const { data: configData, loading, error, reload } = useApi('/config');
  const { data: healthData, reload: reloadHealth } = useApi('/config/health');
  const { data: permsData, reload: reloadPerms } = useApi('/config/permissions');
  const { data: settingsData, reload: reloadSettings } = useApi('/config/settings');

  // Settings form state
  const [settings, setSettings] = useState(null);
  const [dirty, setDirty] = useState({});
  const [saving, setSaving] = useState(null);
  const [msgs, setMsgs] = useState({});

  // Sync settings from API
  useEffect(() => {
    if (settingsData?.settings && !settings) {
      setSettings(JSON.parse(JSON.stringify(settingsData.settings)));
    }
  }, [settingsData]);

  function updateField(section, key, value) {
    setSettings(prev => ({
      ...prev,
      [section]: { ...prev[section], [key]: value },
    }));
    setDirty(d => ({ ...d, [section]: true }));
    setMsgs(m => ({ ...m, [section]: null }));
  }

  async function saveSection(section) {
    const apiSection = section; // section names match API
    setSaving(section);
    setMsgs(m => ({ ...m, [section]: null }));
    try {
      const res = await api.put('/config/settings', { section: apiSection, values: settings[section] });
      setDirty(d => ({ ...d, [section]: false }));
      const text = res.requiresRestart
        ? 'Saved. Restart OpenClaw for changes to take effect.'
        : 'Saved and applied.';
      setMsgs(m => ({ ...m, [section]: { type: 'success', text } }));
      reloadSettings();
    } catch (err) {
      setMsgs(m => ({ ...m, [section]: { type: 'error', text: err.message } }));
    } finally {
      setSaving(null);
    }
  }

  function resetSection(section) {
    if (settingsData?.settings?.[section]) {
      setSettings(prev => ({ ...prev, [section]: JSON.parse(JSON.stringify(settingsData.settings[section])) }));
    }
    setDirty(d => ({ ...d, [section]: false }));
    setMsgs(m => ({ ...m, [section]: null }));
  }

  if (loading) return <div className="loading">Loading settings...</div>;

  const tabProps = (section) => ({
    settings: settings || {},
    onUpdate: updateField,
    onSave: saveSection,
    onReset: resetSection,
    dirty: dirty[section] || false,
    saving: saving === section,
    msg: msgs[section] || null,
  });

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
        <button className="btn btn-sm" onClick={() => { reload(); reloadHealth(); reloadPerms(); reloadSettings(); setSettings(null); setDirty({}); setMsgs({}); }}>Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid var(--border)', marginBottom: 20,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 18px',
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-dim)',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -2,
              cursor: 'pointer',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {!settings && activeTab !== 'permissions' && activeTab !== 'system' ? (
        <div className="loading">Loading configuration...</div>
      ) : (
        <>
          {activeTab === 'general' && <GeneralTab {...tabProps('general')} />}
          {activeTab === 'scheduler' && <SchedulerTab {...tabProps('scheduler')} />}
          {activeTab === 'dispatcher' && <DispatcherTab {...tabProps('dispatcher')} />}
          {activeTab === 'escalation' && <EscalationTab {...tabProps('escalation')} />}
          {activeTab === 'debug' && <DebugTab {...tabProps('debug')} />}
          {activeTab === 'database' && <DatabaseTab {...tabProps('database')} configData={configData} />}
          {activeTab === 'webui' && <WebUITab {...tabProps('webUI')} />}
          {activeTab === 'memory' && <MemoryTab {...tabProps('memory')} />}
          {activeTab === 'permissions' && <PermissionsTab permsData={permsData} reloadPerms={reloadPerms} />}
          {activeTab === 'system' && <SystemTab configData={configData} healthData={healthData} />}
        </>
      )}
    </div>
  );
}

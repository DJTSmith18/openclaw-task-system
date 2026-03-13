import React, { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { api } from '../api';

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const DEFAULT_SWEEP_TOOLS = [
  { tool: 'task_query', params: { status: 'blocked' }, label: 'Blocked tasks' },
  { tool: 'task_query', params: { deadline_within_hours: 4 }, label: 'Approaching deadlines' },
  { tool: 'agent_query', params: {}, label: 'Agent availability' },
  { tool: 'escalation_query', params: { status: 'pending' }, label: 'Pending escalations' },
];


function MemoryConfigPanel({ mem, setMem, allowedTools, agentId }) {
  const enabled = mem.enabled || false;
  const dream = mem.dream || {};
  const rum = mem.rumination || {};
  const sweep = mem.sensor_sweep || {};
  const sweepTools = sweep.tools || DEFAULT_SWEEP_TOOLS;
  const [triggering, setTriggering] = useState(null); // 'dream' | 'rumination' | 'sensor_sweep'

  const update = (section, key, val) => {
    setMem(prev => ({ ...prev, [section]: { ...prev[section], [key]: val } }));
  };

  async function triggerCycle(cycleType) {
    if (!agentId) return;
    setTriggering(cycleType);
    try {
      await api.post(`/agents/${encodeURIComponent(agentId)}/trigger-cycle`, { cycle: cycleType });
    } catch (e) { alert('Trigger failed: ' + e.message); }
    finally { setTriggering(null); }
  }

  // Sensor sweep tool helpers — index-based to support duplicate tool names
  function addSweepTool(toolName) {
    const newTools = [...sweepTools, { tool: toolName, params: {}, label: toolName.replace(/_/g, ' ') }];
    update('sensor_sweep', 'tools', newTools);
  }

  function removeSweepTool(idx) {
    update('sensor_sweep', 'tools', sweepTools.filter((_, i) => i !== idx));
  }

  function updateSweepTool(idx, field, val) {
    const newTools = sweepTools.map((t, i) => {
      if (i !== idx) return t;
      if (field === 'params') {
        try { return { ...t, params: JSON.parse(val) }; } catch { return t; }
      }
      return { ...t, [field]: val };
    });
    update('sensor_sweep', 'tools', newTools);
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Memory System</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={e => setMem(prev => ({ ...prev, enabled: e.target.checked }))}
            style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
      </div>

      {enabled && (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* Dream Cycle */}
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Dream Cycle</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {agentId && dream.enabled !== false && (
                  <button className="btn btn-sm" style={{ fontSize: 10, padding: '2px 8px' }}
                    disabled={triggering === 'dream'} onClick={() => triggerCycle('dream')}>
                    {triggering === 'dream' ? 'Triggering...' : 'Run Now'}
                  </button>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                  <input type="checkbox" checked={dream.enabled !== false} onChange={e => update('dream', 'enabled', e.target.checked)} />
                  {dream.enabled !== false ? 'On' : 'Off'}
                </label>
              </div>
            </div>
            {dream.enabled !== false && (
              <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label>Run at (daily)</label>
                    <input type="time" value={dream.run_at || '03:00'} onChange={e => update('dream', 'run_at', e.target.value)} style={{ fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Max Observations</label>
                    <input type="number" value={dream.max_active_observations || 500} onChange={e => update('dream', 'max_active_observations', parseInt(e.target.value) || 500)} style={{ fontSize: 12 }} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input type="checkbox" checked={dream.decay_enabled !== false} onChange={e => update('dream', 'decay_enabled', e.target.checked)} /> Decay
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input type="checkbox" checked={dream.archive_enabled !== false} onChange={e => update('dream', 'archive_enabled', e.target.checked)} /> Archive
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label>Lookback (days)</label>
                    <input type="number" value={dream.pattern_lookback_days || 7} onChange={e => update('dream', 'pattern_lookback_days', parseInt(e.target.value) || 7)} style={{ fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Min Occurrences</label>
                    <input type="number" value={dream.pattern_min_occurrences || 3} onChange={e => update('dream', 'pattern_min_occurrences', parseInt(e.target.value) || 3)} style={{ fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Min Days</label>
                    <input type="number" value={dream.pattern_min_unique_days || 3} onChange={e => update('dream', 'pattern_min_unique_days', parseInt(e.target.value) || 3)} style={{ fontSize: 12 }} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Rumination */}
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Rumination</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {agentId && rum.enabled !== false && (
                  <button className="btn btn-sm" style={{ fontSize: 10, padding: '2px 8px' }}
                    disabled={triggering === 'rumination'} onClick={() => triggerCycle('rumination')}>
                    {triggering === 'rumination' ? 'Triggering...' : 'Run Now'}
                  </button>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                  <input type="checkbox" checked={rum.enabled !== false} onChange={e => update('rumination', 'enabled', e.target.checked)} />
                  {rum.enabled !== false ? 'On' : 'Off'}
                </label>
              </div>
            </div>
            {rum.enabled !== false && (
              <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label>Every (hours)</label>
                    <input type="number" min="1" value={Math.round((rum.interval_minutes || 240) / 60)} onChange={e => update('rumination', 'interval_minutes', (parseInt(e.target.value) || 4) * 60)} style={{ fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Escalation Threshold</label>
                    <input type="number" step="0.5" value={rum.max_importance_for_escalation || 8.5} onChange={e => update('rumination', 'max_importance_for_escalation', parseFloat(e.target.value) || 8.5)} style={{ fontSize: 12 }} />
                  </div>
                </div>
                <div>
                  <label>Threads</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {['observation', 'reasoning', 'memory', 'planning'].map(t => {
                      const threads = rum.threads || ['observation', 'reasoning', 'memory', 'planning'];
                      return (
                        <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                          <input type="checkbox" checked={threads.includes(t)} onChange={e => {
                            const next = e.target.checked ? [...threads, t] : threads.filter(x => x !== t);
                            update('rumination', 'threads', next);
                          }} />
                          {t}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sensor Sweep */}
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Sensor Sweep</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {agentId && sweep.enabled !== false && (
                  <button className="btn btn-sm" style={{ fontSize: 10, padding: '2px 8px' }}
                    disabled={triggering === 'sensor_sweep'} onClick={() => triggerCycle('sensor_sweep')}>
                    {triggering === 'sensor_sweep' ? 'Triggering...' : 'Run Now'}
                  </button>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                  <input type="checkbox" checked={sweep.enabled !== false} onChange={e => update('sensor_sweep', 'enabled', e.target.checked)} />
                  {sweep.enabled !== false ? 'On' : 'Off'}
                </label>
              </div>
            </div>
            {sweep.enabled !== false && (
              <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label>Every (minutes)</label>
                    <input type="number" min="5" value={sweep.interval_minutes || 120} onChange={e => update('sensor_sweep', 'interval_minutes', parseInt(e.target.value) || 120)} style={{ fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Timeout (sec)</label>
                    <input type="number" value={sweep.timeout_seconds || 120} onChange={e => update('sensor_sweep', 'timeout_seconds', parseInt(e.target.value) || 120)} style={{ fontSize: 12 }} />
                  </div>
                </div>
                <div>
                  <label>Prompt</label>
                  <textarea
                    value={sweep.prompt || ''}
                    onChange={e => update('sensor_sweep', 'prompt', e.target.value)}
                    placeholder={'Run sensor sweep — check system state and record notable changes:\n{toolLines}\nFor each notable finding, call memory_observe with agent_id "{agent_id}", source "sensor_sweep", and appropriate importance (0-10).\nSkip routine/unchanged data — only record what is new or changed. Reply briefly or HEARTBEAT_OK if nothing notable.'}
                    rows={4}
                    style={{ fontSize: 11, fontFamily: 'monospace', resize: 'vertical', width: '100%' }}
                  />
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    Leave blank for default. Variables: <code>{'{toolLines}'}</code> (auto-generated from tools below), <code>{'{agent_id}'}</code>
                  </div>
                </div>
                <div>
                  <label>Tools to Sweep</label>
                  {allowedTools && allowedTools.length > 0 ? (
                    <div style={{ display: 'grid', gap: 4 }}>
                      {sweepTools.map((t, i) => (
                        <div key={i} style={{ background: 'var(--bg)', borderRadius: 4, padding: '4px 6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <code style={{ fontSize: 11, flex: 1 }}>{t.tool}</code>
                            <button className="btn btn-sm" style={{ padding: '1px 5px', fontSize: 10, lineHeight: 1 }}
                              onClick={() => removeSweepTool(i)} title="Remove">&times;</button>
                          </div>
                          <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                            <input value={JSON.stringify(t.params || {})} onChange={e => updateSweepTool(i, 'params', e.target.value)}
                              placeholder="{}" style={{ flex: 1, fontSize: 10 }} title="Parameters (JSON)" />
                            <input value={t.label || ''} onChange={e => updateSweepTool(i, 'label', e.target.value)}
                              placeholder="Label" style={{ flex: 1, fontSize: 10 }} title="Display label" />
                          </div>
                        </div>
                      ))}
                      <select style={{ fontSize: 11, padding: '3px 6px' }} value=""
                        onChange={e => { if (e.target.value) addSweepTool(e.target.value); }}>
                        <option value="">+ Add tool...</option>
                        {allowedTools.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      No tools available — configure agent permissions in Settings &gt; Permissions first
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentModal({ agent, onClose, onSaved, allAgentIds }) {
  const isNew = !agent;
  const [form, setForm] = useState({
    agent_id: agent?.agent_id || '',
    display_name: agent?.display_name || '',
    working_hours_start: agent?.working_hours_start || '08:00',
    working_hours_end: agent?.working_hours_end || '18:00',
    working_days: (agent?.working_days || [1,2,3,4,5]).join(','),
    timezone: agent?.timezone || 'America/Toronto',
    after_hours_capable: agent?.after_hours_capable || false,
    max_concurrent_tasks: agent?.max_concurrent_tasks || 5,
    capabilities: (agent?.capabilities || []).join(', '),
    reports_to: agent?.reports_to || '',
  });
  const [memCfg, setMemCfg] = useState(agent?.metadata?.memory || {});
  const [saving, setSaving] = useState(false);
  const [allowedTools, setAllowedTools] = useState([]);

  // Fetch all tools available to this agent (from OpenClaw CLI or plugin fallback)
  const agentId = isNew ? form.agent_id : agent?.agent_id;
  useEffect(() => {
    if (!agentId) return;
    api.get(`/config/agent-tools/${encodeURIComponent(agentId)}`)
      .then(data => setAllowedTools(data?.tools || []))
      .catch(() => {});
  }, [agentId]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    const agentId = isNew ? form.agent_id : agent.agent_id;
    if (!agentId) return alert('Agent ID is required');
    setSaving(true);
    try {
      const existingMeta = agent?.metadata || {};
      const body = {
        display_name: form.display_name || undefined,
        working_hours_start: form.working_hours_start,
        working_hours_end: form.working_hours_end,
        working_days: form.working_days.split(',').map(Number),
        timezone: form.timezone,
        after_hours_capable: form.after_hours_capable,
        max_concurrent_tasks: parseInt(form.max_concurrent_tasks),
        capabilities: form.capabilities ? form.capabilities.split(',').map(s => s.trim()).filter(Boolean) : [],
        reports_to: form.reports_to || null,
        metadata: { ...existingMeta, memory: memCfg },
      };
      await api.put(`/agents/${agentId}`, body);
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }}>
        <h2>{isNew ? 'Add' : 'Edit'} Agent</h2>
        {isNew && (
          <div className="form-group"><label>Agent ID *</label><input value={form.agent_id} onChange={e => set('agent_id', e.target.value)} placeholder="e.g. dispatch, billing, scheduler" /></div>
        )}
        <div className="form-group"><label>Display Name</label><input value={form.display_name} onChange={e => set('display_name', e.target.value)} placeholder="Friendly name" /></div>
        <div className="form-row">
          <div className="form-group"><label>Hours Start</label><input type="time" value={form.working_hours_start} onChange={e => set('working_hours_start', e.target.value)} /></div>
          <div className="form-group"><label>Hours End</label><input type="time" value={form.working_hours_end} onChange={e => set('working_hours_end', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Working Days (0=Sun, comma-sep)</label><input value={form.working_days} onChange={e => set('working_days', e.target.value)} /></div>
          <div className="form-group"><label>Timezone</label><input value={form.timezone} onChange={e => set('timezone', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Max Concurrent Tasks</label><input type="number" value={form.max_concurrent_tasks} onChange={e => set('max_concurrent_tasks', e.target.value)} /></div>
          <div className="form-group">
            <label>After Hours Capable</label>
            <label className="toggle">
              <input type="checkbox" checked={form.after_hours_capable} onChange={e => set('after_hours_capable', e.target.checked)} />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="form-group"><label>Capabilities (comma-separated)</label><input value={form.capabilities} onChange={e => set('capabilities', e.target.value)} placeholder="dispatch, billing, scheduling" /></div>
        <div className="form-group">
          <label>Reports To (hierarchy)</label>
          <select value={form.reports_to} onChange={e => set('reports_to', e.target.value)}>
            <option value="">— None —</option>
            <option value="human">human (top level)</option>
            {(allAgentIds || []).filter(id => id !== form.agent_id && id !== agent?.agent_id).map(id => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

        <MemoryConfigPanel mem={memCfg} setMem={setMemCfg} allowedTools={allowedTools} agentId={isNew ? null : agent?.agent_id} />

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

export default function Agents() {
  const { data, loading, error, reload } = useApi('/agents');
  useSSE(reload, ['agent']);
  const [editAgent, setEditAgent] = useState(undefined); // undefined=closed, null=new, object=edit
  const [showAdd, setShowAdd] = useState(false);

  if (loading) return <div className="loading">Loading agents...</div>;
  if (error) return <div className="error">{error}</div>;

  const agents = data?.agents || [];

  return (
    <div>
      <div className="page-header">
        <h1>Agents</h1>
        <div className="btn-group">
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>+ Add Agent</button>
          <button className="btn btn-sm" onClick={reload}>Refresh</button>
        </div>
      </div>

      <div className="card-grid" style={{gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))'}}>
        {agents.map(a => (
          <div key={a.agent_id} className="card" style={{cursor:'pointer'}} onClick={() => setEditAgent(a)}>
            <div className="flex-between mb-16">
              <div>
                <div style={{fontWeight:700,fontSize:15}}>{a.display_name || a.agent_id}</div>
                {a.display_name && <div style={{fontSize:12,color:'var(--text-muted)'}}>{a.agent_id}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {a.metadata?.memory?.enabled && <span className="badge" style={{ fontSize: 10, background: 'rgba(138,43,226,0.2)', color: '#ba7de8' }}>MEM</span>}
                <span className={`badge badge-${a.current_status === 'working' ? 'in_progress' : a.current_status === 'idle' ? 'todo' : 'blocked'}`}>
                  {a.current_status || 'idle'}
                </span>
              </div>
            </div>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, color:'var(--text-dim)'}}>
              <div>Tasks: <strong style={{color:'var(--text)'}}>{a.active_task_count || a.task_count || 0}</strong></div>
              <div>Max: <strong style={{color:'var(--text)'}}>{a.max_concurrent_tasks || '\u2014'}</strong></div>
              <div>Hours: {a.working_hours_start || '?'}\u2013{a.working_hours_end || '?'}</div>
              <div>TZ: {a.timezone || '\u2014'}</div>
              <div>Last seen: {timeAgo(a.last_heartbeat)}</div>
              <div>{a.after_hours_capable ? '24/7 capable' : 'Business hours'}</div>
              <div style={{gridColumn:'1/-1'}}>Reports to: <strong style={{color:'var(--text)'}}>{a.reports_to || '\u2014'}</strong></div>
            </div>
            {a.capabilities?.length > 0 && (
              <div style={{marginTop:8}}>{a.capabilities.map(c => <span key={c} className="tag">{c}</span>)}</div>
            )}
          </div>
        ))}
        {agents.length === 0 && <div className="empty" style={{gridColumn:'1/-1'}}>No agents registered yet. Click "+ Add Agent" to register your agents.</div>}
      </div>

      {editAgent && <AgentModal agent={editAgent} allAgentIds={agents.map(a => a.agent_id)} onClose={() => setEditAgent(undefined)} onSaved={() => { setEditAgent(undefined); reload(); }} />}
      {showAdd && <AgentModal agent={null} allAgentIds={agents.map(a => a.agent_id)} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reload(); }} />}
    </div>
  );
}

import React, { useState } from 'react';
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

function AgentModal({ agent, onClose, onSaved }) {
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
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    const agentId = isNew ? form.agent_id : agent.agent_id;
    if (!agentId) return alert('Agent ID is required');
    setSaving(true);
    try {
      const body = {
        display_name: form.display_name || undefined,
        working_hours_start: form.working_hours_start,
        working_hours_end: form.working_hours_end,
        working_days: form.working_days.split(',').map(Number),
        timezone: form.timezone,
        after_hours_capable: form.after_hours_capable,
        max_concurrent_tasks: parseInt(form.max_concurrent_tasks),
        capabilities: form.capabilities ? form.capabilities.split(',').map(s => s.trim()).filter(Boolean) : [],
      };
      await api.put(`/agents/${agentId}`, body);
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
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
              <span className={`badge badge-${a.current_status === 'working' ? 'in_progress' : a.current_status === 'idle' ? 'todo' : 'blocked'}`}>
                {a.current_status || 'idle'}
              </span>
            </div>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12, color:'var(--text-dim)'}}>
              <div>Tasks: <strong style={{color:'var(--text)'}}>{a.active_task_count || a.task_count || 0}</strong></div>
              <div>Max: <strong style={{color:'var(--text)'}}>{a.max_concurrent_tasks || '—'}</strong></div>
              <div>Hours: {a.working_hours_start || '?'}–{a.working_hours_end || '?'}</div>
              <div>TZ: {a.timezone || '—'}</div>
              <div>Last seen: {timeAgo(a.last_heartbeat)}</div>
              <div>{a.after_hours_capable ? '24/7 capable' : 'Business hours'}</div>
            </div>
            {a.capabilities?.length > 0 && (
              <div style={{marginTop:8}}>{a.capabilities.map(c => <span key={c} className="tag">{c}</span>)}</div>
            )}
          </div>
        ))}
        {agents.length === 0 && <div className="empty" style={{gridColumn:'1/-1'}}>No agents registered yet. Click "+ Add Agent" to register your agents.</div>}
      </div>

      {editAgent && <AgentModal agent={editAgent} onClose={() => setEditAgent(undefined)} onSaved={() => { setEditAgent(undefined); reload(); }} />}
      {showAdd && <AgentModal agent={null} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reload(); }} />}
    </div>
  );
}

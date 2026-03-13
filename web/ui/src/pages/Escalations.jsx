import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { useSort } from '../hooks/useSort';
import { api } from '../api';

const ACTIVE_COLUMNS = {
  task: { key: 'task_id', type: 'number' },
  trigger: { key: 'trigger_condition', type: 'string' },
  to: { key: 'to_agent', type: 'string' },
  reason: { key: 'message_sent', type: 'string' },
  status: { key: 'status', type: 'string' },
  triggered: { key: 'created_at', type: 'date' },
};
const RULE_COLUMNS = {
  name: { key: 'name', type: 'string' },
  trigger: { key: 'trigger_condition', type: 'string' },
  from: { key: 'from_agent', type: 'string' },
  to: { key: 'to_agent', type: 'string' },
  threshold: { key: 'timeout_minutes', type: 'number' },
};
const HISTORY_COLUMNS = {
  task: { key: 'task_id', type: 'number' },
  trigger: { key: 'trigger_condition', type: 'string' },
  from: { key: 'from_agent', type: 'string' },
  to: { key: 'to_agent', type: 'string' },
  status: { key: 'status', type: 'string' },
  time: { key: 'created_at', type: 'date' },
};

const TRIGGER_META = {
  timeout:              { label: 'Task Stuck',         desc: 'Task stays in progress too long',       thresholdLabel: 'Minutes in progress before escalating' },
  blocked:             { label: 'Task Blocked',        desc: 'Task blocked for too long',              thresholdLabel: 'Minutes blocked before escalating' },
  deadline_approaching: { label: 'Deadline Warning',   desc: 'Deadline is approaching',                thresholdLabel: 'Minutes before deadline to warn' },
  deadline_missed:     { label: 'Deadline Missed',     desc: 'Deadline has passed',                    thresholdLabel: null },
  after_hours:         { label: 'After Hours Work',    desc: 'Agent working outside scheduled hours',  thresholdLabel: null },
  priority_urgent:     { label: 'Urgent Task Idle',    desc: 'Urgent (P1) task not acted on',          thresholdLabel: 'Minutes idle before escalating' },
  permission_required: { label: 'Manual Escalation',   desc: 'Agent-initiated (not auto-triggered)',   thresholdLabel: null },
};

const TRIGGERS = Object.keys(TRIGGER_META);

function triggerLabel(val) {
  return TRIGGER_META[val]?.label || val;
}

function RuleModal({ rule, onClose, onSaved }) {
  const isNew = !rule;
  const [form, setForm] = useState(rule ? { ...rule } : {
    name: '', trigger_condition: 'timeout', task_category: '', from_agent: '',
    to_agent: '', timeout_minutes: 60, sms_template: '', enabled: true,
    cooldown_minutes: 30, max_escalations: 3, priority_override: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const meta = TRIGGER_META[form.trigger_condition] || {};
  const showThreshold = !!meta.thresholdLabel;

  async function save() {
    if (!form.name || !form.to_agent) return alert('Name and Escalate To required');
    setSaving(true);
    try {
      const body = { ...form, timeout_minutes: parseInt(form.timeout_minutes) || null, cooldown_minutes: parseInt(form.cooldown_minutes) || 30, max_escalations: parseInt(form.max_escalations) || 3, priority_override: form.priority_override ? parseInt(form.priority_override) : null };
      if (isNew) await api.post('/escalation-rules', body);
      else await api.put(`/escalation-rules/${rule.id}`, body);
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{isNew ? 'New' : 'Edit'} Escalation Rule</h2>
        <div className="form-group"><label>Name *</label><input value={form.name} onChange={e => set('name', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label>Trigger</label>
            <select value={form.trigger_condition} onChange={e => set('trigger_condition', e.target.value)}>
              {TRIGGERS.map(t => <option key={t} value={t}>{TRIGGER_META[t].label} — {TRIGGER_META[t].desc}</option>)}
            </select>
          </div>
          {showThreshold && (
            <div className="form-group"><label>{meta.thresholdLabel}</label><input type="number" value={form.timeout_minutes} onChange={e => set('timeout_minutes', e.target.value)} /></div>
          )}
        </div>
        <div className="form-row">
          <div className="form-group"><label>Only for agent</label><input value={form.from_agent} onChange={e => set('from_agent', e.target.value)} placeholder="blank = all" /></div>
          <div className="form-group"><label>Escalate to *</label><input value={form.to_agent} onChange={e => set('to_agent', e.target.value)} placeholder='agent ID or "human"' /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Only for category</label><input value={form.task_category} onChange={e => set('task_category', e.target.value)} placeholder="blank = all" /></div>
          <div className="form-group"><label>Boost priority to</label><input type="number" value={form.priority_override} onChange={e => set('priority_override', e.target.value)} placeholder="none" min={1} max={4} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Minutes between fires</label><input type="number" value={form.cooldown_minutes} onChange={e => set('cooldown_minutes', e.target.value)} /></div>
          <div className="form-group"><label>Max fires per task</label><input type="number" value={form.max_escalations} onChange={e => set('max_escalations', e.target.value)} /></div>
        </div>
        <div className="form-group">
          <label>Notification Message</label>
          <textarea value={form.sms_template || ''} onChange={e => set('sms_template', e.target.value)} placeholder="Task {{task_title}} needs attention. Priority: {{priority}}. Agent: {{assigned_to_agent}}" />
          <small style={{ color: '#888', marginTop: 4 }}>Variables: {'{{task_title}}'}, {'{{task_id}}'}, {'{{priority}}'}, {'{{assigned_to_agent}}'}, {'{{category}}'}, {'{{status}}'}</small>
        </div>
        <div className="form-group">
          <label>Enabled</label>
          <label className="toggle"><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /><span className="toggle-slider" /></label>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Escalations() {
  const [tab, setTab] = useState('active');
  const { data: histData, reload: reloadHist } = useApi('/escalations?limit=50');
  const { data: rulesData, reload: reloadRules } = useApi('/escalation-rules');
  const reloadAll = () => { reloadHist(); reloadRules(); };
  useSSE(reloadAll, ['escalation', 'rule']);
  const [editRule, setEditRule] = useState(undefined); // undefined=closed, null=new

  const active = (histData?.escalations || []).filter(e => e.status === 'pending' || e.status === 'acknowledged');
  const allEscalations = histData?.escalations || [];

  const { sorted: sortedActive, SortTh: ActiveSortTh } = useSort(active, ACTIVE_COLUMNS);
  const { sorted: sortedRules, SortTh: RuleSortTh } = useSort(rulesData?.rules || [], RULE_COLUMNS);
  const { sorted: sortedHistory, SortTh: HistSortTh } = useSort(allEscalations, HISTORY_COLUMNS);

  async function ack(id) { await api.post(`/escalations/${id}/ack`, {}); reloadHist(); }
  async function resolve(id) { await api.post(`/escalations/${id}/resolve`, {}); reloadHist(); }
  async function deleteRule(id) { if (confirm('Delete this rule?')) { await api.delete(`/escalation-rules/${id}`); reloadRules(); } }

  return (
    <div>
      <div className="page-header">
        <h1>Escalations</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setEditRule(null)}>+ New Rule</button>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>Active ({active.length})</button>
        <button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>Rules ({rulesData?.rules?.length || 0})</button>
        <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>History</button>
      </div>

      {tab === 'active' && (
        <div className="card">
          {active.length === 0 ? <div className="empty">No active escalations</div> : (
            <table>
              <thead><tr><ActiveSortTh col="task">Task</ActiveSortTh><ActiveSortTh col="trigger">Trigger</ActiveSortTh><ActiveSortTh col="to">Escalated To</ActiveSortTh><th>Reason</th><ActiveSortTh col="status">Status</ActiveSortTh><ActiveSortTh col="triggered">Triggered</ActiveSortTh><th>Actions</th></tr></thead>
              <tbody>
                {sortedActive.map(e => (
                  <tr key={e.id}>
                    <td><Link to={`/tasks/${e.task_id}`}>{e.task_title || `#${e.task_id}`}</Link></td>
                    <td><span className="tag">{triggerLabel(e.trigger_condition)}</span></td>
                    <td>{e.to_agent}</td>
                    <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.message_sent}</td>
                    <td><span className={`badge badge-${e.status}`}>{e.status}</span></td>
                    <td>{timeAgo(e.created_at)}</td>
                    <td className="btn-group">
                      {e.status === 'pending' && <button className="btn btn-sm" onClick={() => ack(e.id)}>Ack</button>}
                      <button className="btn btn-sm btn-success" onClick={() => resolve(e.id)}>Resolve</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'rules' && (
        <div className="card">
          <table>
            <thead><tr><RuleSortTh col="name">Name</RuleSortTh><RuleSortTh col="trigger">Trigger</RuleSortTh><RuleSortTh col="from">Only for agent</RuleSortTh><RuleSortTh col="to">Escalate to</RuleSortTh><RuleSortTh col="threshold">Threshold</RuleSortTh><th>Enabled</th><th>Actions</th></tr></thead>
            <tbody>
              {sortedRules.map(r => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td><span className="tag">{triggerLabel(r.trigger_condition)}</span></td>
                  <td>{r.from_agent || 'any'}</td>
                  <td>{r.to_agent}</td>
                  <td>{r.timeout_minutes ? `${r.timeout_minutes}m` : '—'}</td>
                  <td>{r.enabled ? <span className="badge badge-healthy">on</span> : <span className="badge badge-cancelled">off</span>}</td>
                  <td className="btn-group">
                    <button className="btn btn-sm" onClick={() => setEditRule(r)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteRule(r.id)}>Del</button>
                  </td>
                </tr>
              ))}
              {!(rulesData?.rules?.length) && <tr><td colSpan={7} className="empty">No rules configured</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'history' && (
        <div className="card">
          <table>
            <thead><tr><HistSortTh col="task">Task</HistSortTh><HistSortTh col="trigger">Trigger</HistSortTh><HistSortTh col="from">From</HistSortTh><HistSortTh col="to">To</HistSortTh><th>Reason</th><HistSortTh col="status">Status</HistSortTh><HistSortTh col="time">Time</HistSortTh></tr></thead>
            <tbody>
              {sortedHistory.map(e => (
                <tr key={e.id}>
                  <td><Link to={`/tasks/${e.task_id}`}>{e.task_title || `#${e.task_id}`}</Link></td>
                  <td><span className="tag">{triggerLabel(e.trigger_condition)}</span></td>
                  <td>{e.from_agent || '—'}</td>
                  <td>{e.to_agent}</td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.message_sent}</td>
                  <td><span className={`badge badge-${e.status}`}>{e.status}</span></td>
                  <td>{timeAgo(e.created_at)}</td>
                </tr>
              ))}
              {!(histData?.escalations?.length) && <tr><td colSpan={7} className="empty">No escalation history</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {editRule !== undefined && <RuleModal rule={editRule} onClose={() => setEditRule(undefined)} onSaved={() => { setEditRule(undefined); reloadRules(); }} />}
    </div>
  );
}

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { api } from '../api';

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function AddWorklogModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ task_id: '', agent_id: '', action: 'time_log', time_spent_minutes: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.task_id || !form.agent_id) return alert('Task ID and Agent required');
    setSaving(true);
    try {
      await api.post('/worklogs', {
        task_id: parseInt(form.task_id), agent_id: form.agent_id,
        action: form.action, time_spent_minutes: parseInt(form.time_spent_minutes) || 0,
        notes: form.notes || undefined,
      });
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Add Work Log Entry</h2>
        <div className="form-row">
          <div className="form-group"><label>Task ID *</label><input type="number" value={form.task_id} onChange={e => set('task_id', e.target.value)} /></div>
          <div className="form-group"><label>Agent ID *</label><input value={form.agent_id} onChange={e => set('agent_id', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Action</label>
            <select value={form.action} onChange={e => set('action', e.target.value)}>
              {['time_log','status_change','note','assignment','escalation','priority_change','deadline_change'].map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="form-group"><label>Time (minutes)</label><input type="number" value={form.time_spent_minutes} onChange={e => set('time_spent_minutes', e.target.value)} /></div>
        </div>
        <div className="form-group"><label>Notes</label><textarea value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

export default function WorkLogs() {
  const [tab, setTab] = useState('log');
  const [agentFilter, setAgentFilter] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const logParams = new URLSearchParams({ limit: '100' });
  if (agentFilter) logParams.set('agent_id', agentFilter);
  if (taskFilter) logParams.set('task_id', taskFilter);

  const { data: logData, loading, reload } = useApi(`/worklogs?${logParams}`, [agentFilter, taskFilter]);
  const { data: reportData } = useApi('/worklogs/report?group_by=agent');
  useSSE(reload, ['worklog']);

  return (
    <div>
      <div className="page-header">
        <h1>Work Logs</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>+ Add Entry</button>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>Activity Log</button>
        <button className={`tab ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>Time Report</button>
      </div>

      {tab === 'log' && (
        <>
          <div className="filter-bar">
            <input placeholder="Filter by agent..." value={agentFilter} onChange={e => setAgentFilter(e.target.value)} style={{maxWidth:180}} />
            <input placeholder="Filter by task ID..." value={taskFilter} onChange={e => setTaskFilter(e.target.value)} style={{maxWidth:140}} />
            <button className="btn btn-sm" onClick={reload}>Refresh</button>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Agent</th><th>Task</th><th>Action</th><th>Duration</th><th>Notes</th></tr></thead>
                <tbody>
                  {loading && <tr><td colSpan={6} className="loading">Loading...</td></tr>}
                  {!loading && (logData?.worklogs || []).map(w => (
                    <tr key={w.id}>
                      <td style={{fontSize:12,color:'var(--text-muted)',whiteSpace:'nowrap'}}>{timeAgo(w.created_at)}</td>
                      <td><code>{w.agent_id}</code></td>
                      <td>{w.task_id ? <Link to={`/tasks/${w.task_id}`}>#{w.task_id}</Link> : '—'}</td>
                      <td><span className="badge">{w.action}</span>
                        {w.status_from && <span style={{fontSize:11,marginLeft:4}}>{w.status_from} → {w.status_to}</span>}
                      </td>
                      <td>{w.time_spent_minutes > 0 ? `${w.time_spent_minutes}m` : '—'}</td>
                      <td style={{maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{w.notes || ''}</td>
                    </tr>
                  ))}
                  {!loading && !(logData?.worklogs?.length) && <tr><td colSpan={6} className="empty">No work log entries</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'report' && (
        <div className="card">
          <table>
            <thead><tr><th>Agent</th><th>Total Minutes</th><th>Entries</th></tr></thead>
            <tbody>
              {(reportData?.report || []).map((r, i) => (
                <tr key={i}>
                  <td><code>{r.agent_id || r.group_key}</code></td>
                  <td><strong>{r.total_minutes || 0}</strong></td>
                  <td>{r.entry_count || 0}</td>
                </tr>
              ))}
              {!(reportData?.report?.length) && <tr><td colSpan={3} className="empty">No time data</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AddWorklogModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reload(); }} />}
    </div>
  );
}

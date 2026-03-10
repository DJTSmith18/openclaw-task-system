import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { api } from '../api';

const STATUSES = ['', 'todo', 'in_progress', 'unblocked', 'blocked', 'done', 'cancelled'];
const PRIORITIES = [
  { value: '', label: 'All' },
  { value: '1', label: 'Urgent' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Normal' },
  { value: '4', label: 'Low' },
];
const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };

function CreateTaskModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', description: '', priority: 3, category: 'general', assigned_to_agent: '', deadline: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const { data: agentList } = useApi('/agents');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.title.trim()) return setErr('Title required');
    setSaving(true);
    try {
      const body = {
        title: form.title, description: form.description || undefined,
        priority: parseInt(form.priority), category: form.category || 'general',
        assigned_to_agent: form.assigned_to_agent || undefined,
        deadline: form.deadline || undefined,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      };
      const t = await api.post('/tasks', body);
      onCreated(t);
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Create Task</h2>
        {err && <div className="error">{err}</div>}
        <div className="form-group"><label>Title *</label><input value={form.title} onChange={e => set('title', e.target.value)} autoFocus /></div>
        <div className="form-group"><label>Description</label><textarea value={form.description} onChange={e => set('description', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label>Priority</label>
            <select value={form.priority} onChange={e => set('priority', e.target.value)}>
              <option value="1">1 - Urgent</option><option value="2">2 - High</option>
              <option value="3">3 - Normal</option><option value="4">4 - Low</option>
            </select>
          </div>
          <div className="form-group"><label>Category</label><input value={form.category} onChange={e => set('category', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Assign To</label>
            <select value={form.assigned_to_agent} onChange={e => set('assigned_to_agent', e.target.value)}>
              <option value="">— Unassigned —</option>
              {(agentList?.agents || []).map(a => <option key={a.agent_id} value={a.agent_id}>{a.agent_id}</option>)}
            </select>
          </div>
          <div className="form-group"><label>Deadline</label><input type="datetime-local" value={form.deadline} onChange={e => set('deadline', e.target.value)} /></div>
        </div>
        <div className="form-group"><label>Tags (comma-separated)</label><input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="billing, urgent" /></div>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Creating...' : 'Create Task'}</button>
        </div>
      </div>
    </div>
  );
}

export default function Tasks() {
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (priority) params.set('priority', priority);
  if (search) params.set('search', search);
  params.set('limit', '100');

  const { data, loading, error, reload } = useApi(`/tasks?${params}`, [status, priority, search]);
  useSSE(reload, ['task']);

  return (
    <div>
      <div className="page-header">
        <h1>Tasks</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Task</button>
      </div>

      <div className="filter-bar">
        <select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {STATUSES.filter(Boolean).map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <select value={priority} onChange={e => setPriority(e.target.value)}>
          {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <input placeholder="Search title..." value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
        <button className="btn btn-sm" onClick={reload}>Refresh</button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Title</th><th>Status</th><th>Priority</th>
                <th>Category</th><th>Assigned To</th><th>Deadline</th><th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="loading">Loading...</td></tr>}
              {!loading && (data?.tasks || []).map(t => (
                <tr key={t.id} className="clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                  <td>{t.id}</td>
                  <td><strong>{t.title}</strong></td>
                  <td><span className={`badge badge-${t.status}`}>{t.status.replace('_', ' ')}</span></td>
                  <td><span className={`priority-${t.priority}`}>{PRIORITY_LABELS[t.priority] || t.priority}</span></td>
                  <td><span className="tag">{t.category}</span></td>
                  <td>{t.assigned_to_agent || <span style={{color:'var(--text-muted)'}}>unassigned</span>}</td>
                  <td>{t.deadline ? new Date(t.deadline).toLocaleDateString() : '—'}</td>
                  <td style={{color:'var(--text-muted)', fontSize:12}}>{new Date(t.updated_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {!loading && !(data?.tasks?.length) && <tr><td colSpan={8} className="empty">No tasks found</td></tr>}
            </tbody>
          </table>
        </div>
        {data?.total > 0 && <div style={{padding:'12px 0', color:'var(--text-dim)', fontSize:12}}>Showing {data.tasks.length} of {data.total}</div>}
      </div>

      {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />}
    </div>
  );
}

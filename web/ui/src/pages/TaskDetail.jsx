import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { api } from '../api';

const STATUSES = ['todo', 'in_progress', 'unblocked', 'blocked', 'done', 'cancelled'];
const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: taskData, loading, error, reload } = useApi(`/tasks/${id}`);
  const { data: commentsData, reload: reloadComments } = useApi(`/tasks/${id}/comments`);
  const { data: depsData, reload: reloadDeps } = useApi(`/tasks/${id}/deps`);
  const { data: logsData, reload: reloadLogs } = useApi(`/worklogs?task_id=${id}&limit=50`);
  const { data: agentList } = useApi('/agents');

  const reloadAll = () => { reload(); reloadComments(); reloadDeps(); reloadLogs(); };
  useSSE(reloadAll, ['task', 'comment', 'worklog']);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [statusNote, setStatusNote] = useState('');
  const [newComment, setNewComment] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('admin');
  const [workMinutes, setWorkMinutes] = useState('');
  const [workNote, setWorkNote] = useState('');

  if (loading) return <div className="loading">Loading task...</div>;
  if (error) return <div className="error">{error}</div>;
  if (!taskData?.task) return <div className="error">Task not found</div>;

  const t = taskData.task;

  function startEdit() {
    setForm({ title: t.title, description: t.description || '', priority: t.priority, category: t.category || '', assigned_to_agent: t.assigned_to_agent || '', deadline: t.deadline ? t.deadline.slice(0, 16) : '', tags: (t.tags || []).join(', ') });
    setEditing(true);
  }

  async function saveEdit() {
    try {
      const body = { ...form, priority: parseInt(form.priority), tags: form.tags ? form.tags.split(',').map(s => s.trim()).filter(Boolean) : [] };
      if (body.deadline) body.deadline = new Date(body.deadline).toISOString();
      else delete body.deadline;
      await api.put(`/tasks/${id}`, body);
      setEditing(false);
      reload();
    } catch (e) { alert(e.message); }
  }

  async function changeStatus(newStatus) {
    // Require note for block and unblock transitions
    const isBlocking = newStatus === 'blocked';
    const isUnblocking = t.status === 'blocked' && newStatus !== 'blocked';
    if ((isBlocking || isUnblocking) && !statusNote.trim()) {
      alert(isBlocking
        ? 'A note is required when blocking. Explain what you need, from whom, and what you tried.'
        : 'A note is required when unblocking. Explain how the blocker was resolved.');
      return;
    }
    try {
      await api.patch(`/tasks/${id}/status`, { status: newStatus, note: statusNote || `Changed to ${newStatus}` });
      setStatusNote('');
      reload();
    } catch (e) { alert(e.message); }
  }

  async function addComment() {
    if (!newComment.trim()) return;
    try {
      await api.post(`/tasks/${id}/comments`, { author: commentAuthor, author_type: 'human', content: newComment });
      setNewComment('');
      reloadComments();
    } catch (e) { alert(e.message); }
  }

  async function addWorklog() {
    try {
      await api.post('/worklogs', { task_id: parseInt(id), agent_id: commentAuthor, action: 'time_log', time_spent_minutes: parseInt(workMinutes) || 0, notes: workNote });
      setWorkMinutes('');
      setWorkNote('');
      reload();
    } catch (e) { alert(e.message); }
  }

  async function deleteTask() {
    if (!confirm('Delete this task?')) return;
    try { await api.delete(`/tasks/${id}`); navigate('/tasks'); } catch (e) { alert(e.message); }
  }

  return (
    <div>
      <div className="page-header">
        <div className="inline-flex">
          <Link to="/tasks" style={{color:'var(--text-dim)'}}>Tasks</Link>
          <span style={{color:'var(--text-muted)'}}>/ #{t.id}</span>
        </div>
        <div className="btn-group">
          <button className="btn btn-sm" onClick={startEdit}>Edit</button>
          <button className="btn btn-sm btn-danger" onClick={deleteTask}>Delete</button>
        </div>
      </div>

      {/* Task Header */}
      <div className="card mb-16">
        {editing ? (
          <div>
            <div className="form-group"><label>Title</label><input value={form.title} onChange={e => setForm(f => ({...f, title: e.target.value}))} /></div>
            <div className="form-group"><label>Description</label><textarea value={form.description} onChange={e => setForm(f => ({...f, description: e.target.value}))} /></div>
            <div className="form-row">
              <div className="form-group"><label>Priority</label>
                <select value={form.priority} onChange={e => setForm(f => ({...f, priority: e.target.value}))}>
                  {[1,2,3,4].map(p => <option key={p} value={p}>{p} - {PRIORITY_LABELS[p]}</option>)}
                </select>
              </div>
              <div className="form-group"><label>Category</label><input value={form.category} onChange={e => setForm(f => ({...f, category: e.target.value}))} /></div>
            </div>
            <div className="form-row">
              <div className="form-group"><label>Assigned To</label>
                <select value={form.assigned_to_agent} onChange={e => setForm(f => ({...f, assigned_to_agent: e.target.value}))}>
                  <option value="">— Unassigned —</option>
                  {(agentList || []).map(a => <option key={a.agent_id} value={a.agent_id}>{a.agent_id}</option>)}
                </select>
              </div>
              <div className="form-group"><label>Deadline</label><input type="datetime-local" value={form.deadline} onChange={e => setForm(f => ({...f, deadline: e.target.value}))} /></div>
            </div>
            <div className="form-group"><label>Tags</label><input value={form.tags} onChange={e => setForm(f => ({...f, tags: e.target.value}))} /></div>
            <div className="modal-actions">
              <button onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn-primary" onClick={saveEdit}>Save</button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex-between mb-16">
              <h2 style={{fontSize:20}}>{t.title}</h2>
              <span className={`badge badge-${t.status}`} style={{fontSize:13,padding:'4px 12px'}}>{t.status.replace('_',' ')}</span>
            </div>
            {t.description && <p style={{color:'var(--text-dim)', marginBottom:16, whiteSpace:'pre-wrap'}}>{t.description}</p>}
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px, 1fr))', gap:12, fontSize:13}}>
              <div><span style={{color:'var(--text-muted)'}}>Priority:</span> <span className={`priority-${t.priority}`}>{PRIORITY_LABELS[t.priority]}</span></div>
              <div><span style={{color:'var(--text-muted)'}}>Category:</span> <span className="tag">{t.category}</span></div>
              <div><span style={{color:'var(--text-muted)'}}>Assigned:</span> {t.assigned_to_agent || 'unassigned'}</div>
              <div><span style={{color:'var(--text-muted)'}}>Created by:</span> {t.created_by_agent || '—'}</div>
              <div><span style={{color:'var(--text-muted)'}}>Deadline:</span> {t.deadline ? new Date(t.deadline).toLocaleString() : '—'}</div>
              <div><span style={{color:'var(--text-muted)'}}>Created:</span> {new Date(t.created_at).toLocaleString()}</div>
              <div><span style={{color:'var(--text-muted)'}}>Est. minutes:</span> {t.estimated_minutes || '—'}</div>
              <div><span style={{color:'var(--text-muted)'}}>Actual minutes:</span> {t.actual_minutes || '—'}</div>
              {t.external_ref_type && <div><span style={{color:'var(--text-muted)'}}>Ext ref:</span> {t.external_ref_type}: {t.external_ref_id}</div>}
            </div>
            {t.tags?.length > 0 && <div style={{marginTop:12}}>{t.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</div>}
          </div>
        )}
      </div>

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:20}}>
        {/* Status Change */}
        <div className="card section">
          <div className="section-title">Change Status</div>
          <div className="form-group">
            <input placeholder={t.status === 'blocked' ? 'Note REQUIRED: explain how blocker was resolved' : 'Note (REQUIRED for block/unblock)'} value={statusNote} onChange={e => setStatusNote(e.target.value)} />
          </div>
          <div className="btn-group" style={{flexWrap:'wrap'}}>
            {(() => {
              // Build valid transitions based on current status
              let options = STATUSES.filter(s => s !== t.status && s !== 'unblocked');
              if (t.status === 'blocked') {
                // Blocked: show Unblock (→unblocked), Done, Cancelled
                return [
                  <button key="unblock" className="btn btn-sm" onClick={() => changeStatus('todo')} style={{borderColor:'var(--yellow)',color:'var(--yellow)'}}>unblock</button>,
                  <button key="done" className="btn btn-sm btn-success" onClick={() => changeStatus('done')}>done</button>,
                  <button key="cancelled" className="btn btn-sm btn-danger" onClick={() => changeStatus('cancelled')}>cancelled</button>,
                ];
              }
              if (t.status === 'unblocked') {
                // Unblocked: show In Progress, Blocked, Done, Cancelled
                options = ['in_progress', 'blocked', 'done', 'cancelled'];
              }
              return options.map(s => (
                <button key={s} className={`btn btn-sm ${s === 'done' ? 'btn-success' : s === 'cancelled' ? 'btn-danger' : ''}`} onClick={() => changeStatus(s)}>
                  {s.replace('_', ' ')}
                </button>
              ));
            })()}
          </div>
        </div>

        {/* Log Work */}
        <div className="card section">
          <div className="section-title">Log Work</div>
          <div className="form-row">
            <div className="form-group"><label>Agent</label><input value={commentAuthor} onChange={e => setCommentAuthor(e.target.value)} /></div>
            <div className="form-group"><label>Minutes</label><input type="number" value={workMinutes} onChange={e => setWorkMinutes(e.target.value)} /></div>
          </div>
          <div className="form-group"><label>Notes</label><input value={workNote} onChange={e => setWorkNote(e.target.value)} /></div>
          <button className="btn btn-sm btn-primary" onClick={addWorklog}>Log</button>
        </div>
      </div>

      {/* Dependencies */}
      {depsData && (depsData.depends_on?.length > 0 || depsData.depended_by?.length > 0) && (
        <div className="card section mt-16">
          <div className="section-title">Dependencies</div>
          {depsData.depends_on?.length > 0 && <div className="mb-16"><strong style={{fontSize:12,color:'var(--text-dim)'}}>Depends on:</strong> {depsData.depends_on.map(d => <Link key={d.depends_on_task_id} to={`/tasks/${d.depends_on_task_id}`} className="tag" style={{marginLeft:4}}>#{d.depends_on_task_id} {d.title}</Link>)}</div>}
          {depsData.depended_by?.length > 0 && <div className="mb-16"><strong style={{fontSize:12,color:'var(--text-dim)'}}>Depended by:</strong> {depsData.depended_by.map(d => <Link key={d.task_id} to={`/tasks/${d.task_id}`} className="tag" style={{marginLeft:4}}>#{d.task_id} {d.title}</Link>)}</div>}
        </div>
      )}

      {/* Unified Activity Timeline */}
      <div className="card section mt-16">
        <div className="section-title">Activity Timeline</div>
        <div className="timeline" style={{marginBottom:16}}>
          {(() => {
            const entries = [];
            // Work logs
            for (const w of (logsData?.work_logs || [])) {
              entries.push({ type: 'log', ts: new Date(w.created_at), data: w });
            }
            // Comments
            for (const c of (commentsData?.comments || [])) {
              entries.push({ type: 'comment', ts: new Date(c.created_at), data: c });
            }
            // Sort oldest-first (reading order)
            entries.sort((a, b) => a.ts - b.ts);

            if (entries.length === 0) return <div className="empty" style={{padding:16}}>No activity yet</div>;

            const DOT_COLORS = {
              status_change: 'var(--green)',
              escalation: 'var(--yellow)',
              assignment: 'var(--text-muted)',
              priority_change: 'var(--text-muted)',
              time_log: 'var(--text-muted)',
              comment: 'var(--accent)',
            };

            return entries.map((e, i) => {
              if (e.type === 'comment') {
                const c = e.data;
                return (
                  <div key={`c-${c.id}`} className="timeline-item">
                    <div className="timeline-dot" style={{background: DOT_COLORS.comment}} />
                    <div className="timeline-content">
                      <div className="flex-between">
                        <span className="timeline-agent">{c.author} <span className="tag">{c.author_type}</span> <span className="badge" style={{marginLeft:4}}>comment</span></span>
                        <span className="timeline-time" title={e.ts.toLocaleString()}>{timeAgo(c.created_at)}</span>
                      </div>
                      <div className="timeline-note" style={{whiteSpace:'pre-wrap', marginTop:4}}>{c.content}</div>
                    </div>
                  </div>
                );
              }
              // Work log entry
              const w = e.data;
              const dotColor = DOT_COLORS[w.action] || 'var(--text-muted)';
              return (
                <div key={`w-${w.id}`} className="timeline-item">
                  <div className="timeline-dot" style={{background: dotColor}} />
                  <div className="timeline-content">
                    <div className="flex-between">
                      <span className="timeline-agent">{w.agent_id}</span>
                      <span className="timeline-time" title={e.ts.toLocaleString()}>{timeAgo(w.created_at)}</span>
                    </div>
                    <div className="timeline-note">
                      <span className="badge">{w.action.replace('_', ' ')}</span>
                      {w.status_from && <span style={{marginLeft:6,fontSize:12}}>{w.status_from} → {w.status_to}</span>}
                      {w.time_spent_minutes > 0 && <span className="tag" style={{marginLeft:6}}>{w.time_spent_minutes}m</span>}
                      {w.notes && <div style={{marginTop:4,color:'var(--text-dim)',whiteSpace:'pre-wrap'}}>{w.notes}</div>}
                    </div>
                  </div>
                </div>
              );
            });
          })()}
        </div>

        {/* Comment form at bottom of timeline */}
        <div style={{borderTop:'1px solid var(--border)', paddingTop:12}}>
          <div className="form-group"><textarea rows={2} placeholder="Add a comment..." value={newComment} onChange={e => setNewComment(e.target.value)} /></div>
          <button className="btn btn-sm btn-primary" onClick={addComment} disabled={!newComment.trim()}>Add Comment</button>
        </div>
      </div>
    </div>
  );
}

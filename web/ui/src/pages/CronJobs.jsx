import React, { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { api } from '../api';
import ScheduleBuilder, { describeCron } from '../components/ScheduleBuilder';

function formatSchedule(sched) {
  if (!sched) return '—';
  if (typeof sched === 'string') return sched;
  if (sched.expr) return sched.expr;
  if (sched.kind === 'every' && sched.everyMs) {
    const ms = sched.everyMs;
    if (ms >= 86400000) return `every ${Math.round(ms / 86400000)}d`;
    if (ms >= 3600000) return `every ${Math.round(ms / 3600000)}h`;
    if (ms >= 60000) return `every ${Math.round(ms / 60000)}m`;
    return `every ${Math.round(ms / 1000)}s`;
  }
  if (sched.kind === 'cron') return sched.expression || sched.expr || JSON.stringify(sched);
  return JSON.stringify(sched);
}

function getScheduleEditValue(sched) {
  if (!sched) return '';
  if (typeof sched === 'string') return sched;
  if (sched.expr) return sched.expr;
  if (sched.expression) return sched.expression;
  if (sched.kind === 'every' && sched.everyMs) {
    const ms = sched.everyMs;
    if (ms >= 60000) return `every ${Math.round(ms / 60000)}m`;
    return `every ${Math.round(ms / 1000)}s`;
  }
  return '';
}

function getScheduleTz(sched) {
  if (!sched) return 'America/Toronto';
  if (typeof sched === 'object' && sched.tz) return sched.tz;
  return 'America/Toronto';
}

// ── Agent Wake Modal ──────────────────────────────────────────────────────────

function AgentJobModal({ job, onClose, onSaved }) {
  const isNew = !job;
  const [form, setForm] = useState(job ? {
    agentId: job.agentId, name: job.name,
    schedule: getScheduleEditValue(job.schedule),
    tz: getScheduleTz(job.schedule),
    message: job.payload?.message || '',
    timeoutSeconds: job.payload?.timeoutSeconds || 120,
    sessionTarget: job.sessionTarget || 'isolated', wakeMode: job.wakeMode || 'now',
    enabled: job.enabled,
  } : {
    agentId: '', name: '', schedule: '*/5 * * * *', tz: 'America/Toronto',
    message: '', timeoutSeconds: 120, sessionTarget: 'isolated', wakeMode: 'now', enabled: true,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.agentId || !form.name || !form.schedule || !form.message) return alert('All fields required');
    setSaving(true);
    try {
      const body = {
        agentId: form.agentId, name: form.name, enabled: form.enabled,
        schedule: form.schedule, message: form.message,
        timeoutSeconds: parseInt(form.timeoutSeconds), sessionTarget: form.sessionTarget,
        wakeMode: form.wakeMode,
      };
      if (isNew) await api.post('/cron/jobs', body);
      else await api.put(`/cron/jobs/${job.id}`, body);
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  return (
    <>
      <div className="form-row">
        <div className="form-group"><label>Name *</label><input value={form.name} onChange={e => set('name', e.target.value)} /></div>
        <div className="form-group"><label>Agent ID *</label><input value={form.agentId} onChange={e => set('agentId', e.target.value)} /></div>
      </div>
      <ScheduleBuilder value={form.schedule} onChange={v => set('schedule', v)} />
      <div className="form-group"><label>Timezone</label><input value={form.tz} onChange={e => set('tz', e.target.value)} /></div>
      <div className="form-group"><label>Message *</label><textarea value={form.message} onChange={e => set('message', e.target.value)} placeholder="What the agent should do..." /></div>
      <div className="form-row-3">
        <div className="form-group"><label>Timeout (sec)</label><input type="number" value={form.timeoutSeconds} onChange={e => set('timeoutSeconds', e.target.value)} /></div>
        <div className="form-group"><label>Session Target</label>
          <select value={form.sessionTarget} onChange={e => set('sessionTarget', e.target.value)}>
            <option value="isolated">Isolated</option><option value="shared">Shared</option>
          </select>
        </div>
        <div className="form-group"><label>Wake Mode</label>
          <select value={form.wakeMode} onChange={e => set('wakeMode', e.target.value)}>
            <option value="now">Now</option><option value="deferred">Deferred</option>
          </select>
        </div>
      </div>
      <div className="form-group">
        <label>Enabled</label>
        <label className="toggle"><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /><span className="toggle-slider" /></label>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </>
  );
}

// ── Task Template Modal ───────────────────────────────────────────────────────

function TaskTemplateModal({ template, onClose, onSaved }) {
  const isNew = !template;
  const [form, setForm] = useState(template ? {
    name: template.name,
    schedule_expr: template.schedule_expr,
    schedule_tz: template.schedule_tz || 'America/Toronto',
    task_title_template: template.task_title_template,
    task_description_template: template.task_description_template || '',
    task_priority: template.task_priority || 3,
    task_category: template.task_category || 'general',
    assigned_to_agent: template.assigned_to_agent || '',
    deadline_offset_minutes: template.deadline_offset_minutes || '',
    tags: (template.tags || []).join(', '),
    after_hours_auth: template.after_hours_auth || false,
    run_once: template.run_once || false,
    enabled: template.enabled,
  } : {
    name: '', schedule_expr: '0 9 * * *', schedule_tz: 'America/Toronto',
    task_title_template: '', task_description_template: '',
    task_priority: 3, task_category: 'general', assigned_to_agent: '',
    deadline_offset_minutes: '', tags: '', after_hours_auth: false,
    run_once: false, enabled: true,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.name || !form.schedule_expr || !form.task_title_template) return alert('Name, schedule, and title template required');
    setSaving(true);
    try {
      const body = {
        name: form.name,
        enabled: form.enabled,
        run_once: form.run_once,
        schedule_expr: form.schedule_expr,
        schedule_tz: form.schedule_tz,
        task_title_template: form.task_title_template,
        task_description_template: form.task_description_template || null,
        task_priority: parseInt(form.task_priority),
        task_category: form.task_category,
        assigned_to_agent: form.assigned_to_agent || null,
        deadline_offset_minutes: form.deadline_offset_minutes ? parseInt(form.deadline_offset_minutes) : null,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        after_hours_auth: form.after_hours_auth,
      };
      if (isNew) await api.post('/task-templates', body);
      else await api.put(`/task-templates/${template.id}`, body);
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  return (
    <>
      <div className="form-group"><label>Name *</label><input value={form.name} onChange={e => set('name', e.target.value)} /></div>
      <ScheduleBuilder value={form.schedule_expr} onChange={v => set('schedule_expr', v)}
        runOnce={form.run_once} onRunOnceChange={v => set('run_once', v)} />
      <div className="form-group"><label>Timezone</label><input value={form.schedule_tz} onChange={e => set('schedule_tz', e.target.value)} /></div>
      <div className="form-group">
        <label>Title Template *</label>
        <input value={form.task_title_template} onChange={e => set('task_title_template', e.target.value)} placeholder="Standup for {{day}}" />
      </div>
      <div className="form-group">
        <label>Description Template</label>
        <textarea value={form.task_description_template} onChange={e => set('task_description_template', e.target.value)} placeholder="Daily standup report for {{date}}" />
      </div>
      <div style={{ fontSize: '0.8em', color: 'var(--text-secondary)', marginBottom: 8 }}>
        Available: {'{{date}}, {{time}}, {{datetime}}, {{day}}, {{day_short}}, {{month}}, {{year}}, {{week_number}}, {{timestamp}}'}
      </div>
      <div className="form-row-3">
        <div className="form-group"><label>Priority</label>
          <select value={form.task_priority} onChange={e => set('task_priority', e.target.value)}>
            <option value={1}>1 - Urgent</option><option value={2}>2 - High</option>
            <option value={3}>3 - Normal</option><option value={4}>4 - Low</option>
          </select>
        </div>
        <div className="form-group"><label>Category</label><input value={form.task_category} onChange={e => set('task_category', e.target.value)} /></div>
        <div className="form-group"><label>Assigned Agent</label><input value={form.assigned_to_agent} onChange={e => set('assigned_to_agent', e.target.value)} /></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label>Deadline Offset (min)</label><input type="number" value={form.deadline_offset_minutes} onChange={e => set('deadline_offset_minutes', e.target.value)} placeholder="e.g. 60" /></div>
        <div className="form-group"><label>Tags (comma-separated)</label><input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="daily, standup" /></div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Run Once</label>
          <label className="toggle"><input type="checkbox" checked={form.run_once} onChange={e => set('run_once', e.target.checked)} /><span className="toggle-slider" /></label>
        </div>
        <div className="form-group">
          <label>After Hours Auth</label>
          <label className="toggle"><input type="checkbox" checked={form.after_hours_auth} onChange={e => set('after_hours_auth', e.target.checked)} /><span className="toggle-slider" /></label>
        </div>
        <div className="form-group">
          <label>Enabled</label>
          <label className="toggle"><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /><span className="toggle-slider" /></label>
        </div>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </>
  );
}

// ── Unified Modal ─────────────────────────────────────────────────────────────

function CronModal({ editItem, onClose, onSaved }) {
  const isEditing = !!editItem;
  const initialMode = editItem?._type === 'template' ? 'task' : 'agent';
  const [mode, setMode] = useState(initialMode);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{isEditing ? 'Edit' : 'New'} {mode === 'agent' ? 'Agent Wake Job' : 'Task Template'}</h2>
        {!isEditing && (
          <div style={{ display: 'flex', gap: 0, marginBottom: 16 }}>
            <button className={`btn btn-sm ${mode === 'agent' ? 'btn-primary' : ''}`}
              style={{ borderRadius: '4px 0 0 4px' }} onClick={() => setMode('agent')}>Wake Agent</button>
            <button className={`btn btn-sm ${mode === 'task' ? 'btn-primary' : ''}`}
              style={{ borderRadius: '0 4px 4px 0' }} onClick={() => setMode('task')}>Create Task</button>
          </div>
        )}
        {mode === 'agent'
          ? <AgentJobModal job={isEditing ? editItem : null} onClose={onClose} onSaved={onSaved} />
          : <TaskTemplateModal template={isEditing ? editItem : null} onClose={onClose} onSaved={onSaved} />
        }
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CronJobs() {
  const { data: cronData, loading: cronLoading, error: cronError, reload: cronReload } = useApi('/cron/jobs');
  const { data: tmplData, loading: tmplLoading, error: tmplError, reload: tmplReload } = useApi('/task-templates');
  useSSE(() => { cronReload(); tmplReload(); }, ['cron']);
  const [editItem, setEditItem] = useState(undefined);

  async function toggleAgent(id) { await api.patch(`/cron/jobs/${id}/toggle`); cronReload(); }
  async function deleteAgent(id) { if (confirm('Delete this cron job?')) { await api.delete(`/cron/jobs/${id}`); cronReload(); } }
  async function toggleTemplate(id) { await api.patch(`/task-templates/${id}/toggle`); tmplReload(); }
  async function deleteTemplate(id) { if (confirm('Delete this task template?')) { await api.delete(`/task-templates/${id}`); tmplReload(); } }

  if (cronLoading || tmplLoading) return <div className="loading">Loading...</div>;
  if (cronError || tmplError) return <div className="error">{cronError || tmplError}</div>;

  const agentJobs = (cronData?.jobs || []).map(j => ({ ...j, _type: 'agent' }));
  const templates = (tmplData?.templates || []).map(t => ({ ...t, _type: 'template' }));
  const allItems = [...agentJobs, ...templates];

  function reload() { cronReload(); tmplReload(); }

  return (
    <div>
      <div className="page-header">
        <h1>Cron Jobs</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setEditItem(null)}>+ New</button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Name</th><th>Schedule</th><th>Details</th><th>Enabled</th><th>Actions</th></tr></thead>
            <tbody>
              {allItems.map(item => {
                const isAgent = item._type === 'agent';
                const schedule = isAgent ? formatSchedule(item.schedule) : item.schedule_expr;
                const scheduleDesc = isAgent ? '' : describeCron(item.schedule_expr);
                return (
                  <tr key={`${item._type}-${item.id}`}>
                    <td>
                      <span className={`badge ${isAgent ? 'badge-info' : 'badge-success'}`}
                        style={{ fontSize: '0.75em', padding: '2px 6px' }}>
                        {isAgent ? 'Agent' : 'Task'}
                      </span>
                    </td>
                    <td><strong>{item.name}</strong></td>
                    <td>
                      <code>{schedule}</code>
                      {scheduleDesc && <div style={{ fontSize: '0.8em', color: 'var(--text-secondary)' }}>{scheduleDesc}</div>}
                    </td>
                    <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {isAgent
                        ? <><code>{item.agentId}</code> — {item.payload?.message}</>
                        : <>{item.task_title_template}{item.assigned_to_agent ? <> — <code>{item.assigned_to_agent}</code></> : ''}</>
                      }
                    </td>
                    <td>
                      <label className="toggle" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={item.enabled}
                          onChange={() => isAgent ? toggleAgent(item.id) : toggleTemplate(item.id)} />
                        <span className="toggle-slider" />
                      </label>
                    </td>
                    <td className="btn-group">
                      <button className="btn btn-sm" onClick={() => setEditItem(item)}>Edit</button>
                      <button className="btn btn-sm btn-danger"
                        onClick={() => isAgent ? deleteAgent(item.id) : deleteTemplate(item.id)}>Del</button>
                    </td>
                  </tr>
                );
              })}
              {allItems.length === 0 && <tr><td colSpan={6} className="empty">No cron jobs or task templates</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editItem !== undefined && <CronModal editItem={editItem} onClose={() => setEditItem(undefined)}
        onSaved={() => { setEditItem(undefined); reload(); }} />}
    </div>
  );
}

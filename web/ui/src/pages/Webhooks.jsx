import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { useSort } from '../hooks/useSort';
import { api } from '../api';

const TMPL_COLUMNS = {
  name: { key: 'name', type: 'string' },
  source: { key: 'source_name', type: 'string' },
  category: { key: 'task_category', type: 'string' },
  assigned: { key: 'assigned_to_agent', type: 'string' },
};
const LOG_COLUMNS = {
  time: { key: 'created_at', type: 'date' },
  source: { key: 'source_name', type: 'string' },
  status: { key: 'processing_status', type: 'string' },
  template: { key: 'matched_template_id', type: 'number' },
  task: { key: 'created_task_id', type: 'number' },
};

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Source Modal ──────────────────────────────────────────────────────────────
function SourceModal({ source, onClose, onSaved }) {
  const isNew = !source;
  const [form, setForm] = useState(source ? {
    name: source.name, slug: source.slug, description: source.description || '',
    secret: source.secret || '', enabled: source.enabled !== false,
    forward_url: source.forward_url || '', headers_to_extract: (source.headers_to_extract || []).join(', '),
  } : { name: '', slug: '', description: '', secret: '', enabled: true, forward_url: '', headers_to_extract: '' });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.name || !form.slug) return alert('Name and slug required');
    setSaving(true);
    try {
      const body = { ...form, headers_to_extract: form.headers_to_extract ? form.headers_to_extract.split(',').map(s => s.trim()).filter(Boolean) : [] };
      if (isNew) await api.post('/webhook-sources', body);
      else await api.put(`/webhook-sources/${source.id}`, body);
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  const endpointUrl = form.slug ? `${window.location.protocol}//${window.location.hostname}:${window.location.port || 18790}/webhooks/${form.slug}` : '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{isNew ? 'New' : 'Edit'} Webhook Source</h2>
        {endpointUrl && <div style={{background:'var(--bg-input)',padding:'8px 12px',borderRadius:6,marginBottom:16,fontSize:12,fontFamily:'monospace',wordBreak:'break-all'}}>
          Endpoint: <strong>{endpointUrl}</strong>
          <button className="btn btn-sm" style={{marginLeft:8,padding:'2px 8px'}} onClick={() => navigator.clipboard.writeText(endpointUrl)}>Copy</button>
        </div>}
        <div className="form-row">
          <div className="form-group"><label>Name *</label><input value={form.name} onChange={e => set('name', e.target.value)} /></div>
          <div className="form-group"><label>Slug * (URL path)</label><input value={form.slug} onChange={e => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="my-source" /></div>
        </div>
        <div className="form-group"><label>Description</label><input value={form.description} onChange={e => set('description', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label>HMAC Secret (optional)</label><input value={form.secret} onChange={e => set('secret', e.target.value)} placeholder="Leave empty to skip verification" /></div>
          <div className="form-group"><label>Forward URL (optional)</label><input value={form.forward_url} onChange={e => set('forward_url', e.target.value)} placeholder="http://localhost:8090" /></div>
        </div>
        <div className="form-group"><label>Headers to Extract (comma-sep)</label><input value={form.headers_to_extract} onChange={e => set('headers_to_extract', e.target.value)} placeholder="X-GitHub-Event, X-Request-ID" /></div>
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

// ── Sidebar Panel (Variables + Syntax Reference) ────────────────────────────
function SidebarPanel({ allVars, insertVar, rawPayload }) {
  const [sideTab, setSideTab] = useState('vars');
  const sideTabStyle = (id) => ({
    padding: '6px 10px', fontSize: 11, fontWeight: sideTab === id ? 600 : 400,
    color: sideTab === id ? 'var(--accent)' : 'var(--text-dim)',
    background: 'transparent', border: 'none', cursor: 'pointer',
    borderBottom: sideTab === id ? '2px solid var(--accent)' : '2px solid transparent',
    marginBottom: -1,
  });

  return (
    <div>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 10 }}>
        <button style={sideTabStyle('vars')} onClick={() => setSideTab('vars')}>Variables</button>
        <button style={sideTabStyle('ref')} onClick={() => setSideTab('ref')}>Syntax</button>
        <button style={sideTabStyle('raw')} onClick={() => setSideTab('raw')}>Raw Payload</button>
      </div>

      {sideTab === 'vars' && (
        <>
          <div className="var-list">
            {Object.keys(allVars).length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>No variables available. Send a webhook event first, then create a template from the Unmatched tab.</div>
            ) : (
              Object.entries(allVars).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => (
                <div key={k} className="var-item" onClick={() => insertVar(k)} title={`Click to insert {{${k}}}`}>
                  <span className="var-name">{k}</span>
                  <span className="var-value">{String(v)}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Click a variable to insert <code>{'{{var}}'}</code> at cursor.</div>
        </>
      )}

      {sideTab === 'ref' && (
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)', maxHeight: '60vh', overflowY: 'auto' }}>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ color: 'var(--text)' }}>Simple Variable</strong>
            <pre style={{ margin: '4px 0', padding: 8, background: 'var(--bg-input)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{'{{data.driver.name}}'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ color: 'var(--text)' }}>Fallback (default value)</strong>
            <pre style={{ margin: '4px 0', padding: 8, background: 'var(--bg-input)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{'{{data.driver.name || "Unknown"}}'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ color: 'var(--text)' }}>Conditional (ternary)</strong>
            <pre style={{ margin: '4px 0', padding: 8, background: 'var(--bg-input)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{'{{data.dvir.hasDefects ? "DEFECTS FOUND" : "All clear"}}'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ color: 'var(--text)' }}>Array Length</strong>
            <pre style={{ margin: '4px 0', padding: 8, background: 'var(--bg-input)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{'{{data.dvir.defects.length}} defects'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ color: 'var(--text)' }}>Direct Array Access</strong>
            <pre style={{ margin: '4px 0', padding: 8, background: 'var(--bg-input)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{'First: {{data.dvir.defects.0.defectType}}'}</pre>
          </div>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ color: 'var(--text)' }}>Loop Over Array</strong>
            <pre style={{ margin: '4px 0', padding: 8, background: 'var(--bg-input)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{'{{#each data.dvir.defects}}{{@number}}. {{defectType}}: {{comment}}\n{{/each}}'}</pre>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Inside <code>{'{{#each}}'}</code> blocks:<br/>
              <code>{'{{propName}}'}</code> — property from current item<br/>
              <code>{'{{nested.prop}}'}</code> — nested property from item<br/>
              <code>{'{{@index}}'}</code> — 0-based position<br/>
              <code>{'{{@number}}'}</code> — 1-based position<br/>
              Full paths like <code>{'{{data.driver.name}}'}</code> still resolve from the parent payload.
            </div>
          </div>
        </div>
      )}

      {sideTab === 'raw' && (
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {rawPayload ? (
            <pre style={{ margin: 0, padding: 10, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
              {JSON.stringify(rawPayload, null, 2)}
            </pre>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>No payload available. Create a template from an unmatched event to see the raw payload here.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Template Modal ───────────────────────────────────────────────────────────
function TemplateModal({ template, sources, vars, onClose, onSaved }) {
  const isNew = !template;
  const [form, setForm] = useState(template ? {
    source_id: template.source_id, name: template.name, enabled: template.enabled !== false,
    match_rules: typeof template.match_rules === 'string' ? JSON.parse(template.match_rules) : (template.match_rules || []),
    task_title_template: template.task_title_template || '',
    task_description_template: template.task_description_template || '',
    task_priority_expr: template.task_priority_expr || '3',
    task_category: template.task_category || 'general',
    assigned_to_agent: template.assigned_to_agent || '',
    deadline_offset_minutes: template.deadline_offset_minutes || '',
    external_ref_type: template.external_ref_type || '',
    external_ref_id_expr: template.external_ref_id_expr || '',
    tags: (template.tags || []).join(', '),
  } : {
    source_id: '', name: '', enabled: true, match_rules: [],
    task_title_template: '', task_description_template: '',
    task_priority_expr: '3', task_category: 'general', assigned_to_agent: '',
    deadline_offset_minutes: '', external_ref_type: '', external_ref_id_expr: '', tags: '',
  });
  const [saving, setSaving] = useState(false);
  const [activeField, setActiveField] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function addRule() {
    set('match_rules', [...form.match_rules, { path: '', op: 'eq', value: '' }]);
  }
  function updateRule(i, field, val) {
    const rules = [...form.match_rules];
    rules[i] = { ...rules[i], [field]: val };
    // Auto-set value to true when switching to "exists" operator
    if (field === 'op' && val === 'exists') rules[i].value = true;
    set('match_rules', rules);
  }
  function removeRule(i) {
    set('match_rules', form.match_rules.filter((_, idx) => idx !== i));
  }

  function insertVar(varName) {
    if (!activeField) return;
    const el = document.getElementById(`tmpl-${activeField}`);
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const current = form[activeField];
    const newVal = current.substring(0, start) + `{{${varName}}}` + current.substring(end);
    set(activeField, newVal);
    setTimeout(() => {
      el.focus();
      const pos = start + varName.length + 4;
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  async function save() {
    if (!form.source_id || !form.name || !form.task_title_template) return alert('Source, name, and title template required');
    setSaving(true);
    try {
      const body = {
        ...form, source_id: parseInt(form.source_id),
        deadline_offset_minutes: form.deadline_offset_minutes ? parseInt(form.deadline_offset_minutes) : null,
        tags: form.tags ? form.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
      };
      if (isNew) await api.post('/webhook-templates', body);
      else await api.put(`/webhook-templates/${template.id}`, body);
      onSaved();
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  }

  const allVars = vars?.vars || vars || {};
  const rawPayload = vars?.payload || null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <h2>{isNew ? 'New' : 'Edit'} Webhook Template</h2>
        <div style={{display:'grid', gridTemplateColumns:'1fr 320px', gap:20}}>
          <div>
            <div className="form-row">
              <div className="form-group"><label>Source *</label>
                <select value={form.source_id} onChange={e => set('source_id', e.target.value)}>
                  <option value="">Select source...</option>
                  {(sources || []).map(s => <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>)}
                </select>
              </div>
              <div className="form-group"><label>Template Name *</label><input value={form.name} onChange={e => set('name', e.target.value)} /></div>
            </div>

            {/* Match Rules */}
            <div className="section">
              <div className="flex-between"><div className="section-title">Match Rules (AND)</div><button className="btn btn-sm" onClick={addRule}>+ Rule</button></div>
              {form.match_rules.map((rule, i) => (
                <div key={i} className="form-row-3" style={{marginBottom:8, alignItems:'end'}}>
                  <div className="form-group"><label>Path</label><input value={rule.path} onChange={e => updateRule(i, 'path', e.target.value)} placeholder="event" /></div>
                  <div className="form-group"><label>Op</label>
                    <select value={rule.op} onChange={e => updateRule(i, 'op', e.target.value)}>
                      {['eq','neq','glob','regex','in','gt','lt','exists'].map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                  <div className="form-group" style={{position:'relative'}}>
                    <label>Value</label>
                    <div style={{display:'flex',gap:4}}>
                      {rule.op === 'exists'
                        ? <span style={{padding:'6px 10px',color:'var(--text-muted)',fontSize:12}}>key exists</span>
                        : <input value={typeof rule.value === 'object' ? JSON.stringify(rule.value) : rule.value} onChange={e => updateRule(i, 'value', e.target.value)} />
                      }
                      <button className="btn btn-sm btn-danger" style={{padding:'4px 8px'}} onClick={() => removeRule(i)}>×</button>
                    </div>
                  </div>
                </div>
              ))}
              {form.match_rules.length === 0 && <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:12}}>No rules = match all events from this source</div>}
            </div>

            {/* Task Template */}
            <div className="section">
              <div className="section-title">Task Template</div>
              <div className="form-group">
                <label>Title * (use {'{{var}}'} for variables)</label>
                <input id="tmpl-task_title_template" value={form.task_title_template} onChange={e => set('task_title_template', e.target.value)} onFocus={() => setActiveField('task_title_template')} placeholder="New event: {{data.name}}" />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea id="tmpl-task_description_template" value={form.task_description_template} onChange={e => set('task_description_template', e.target.value)} onFocus={() => setActiveField('task_description_template')} placeholder="Details: {{data.details}}" />
                <small style={{color:'var(--text-muted)',marginTop:4,display:'block'}}>Use {'{{var}}'} syntax. See reference in the sidebar.</small>
              </div>
              <div className="form-row-3">
                <div className="form-group"><label>Priority (1-4 or expr)</label><input id="tmpl-task_priority_expr" value={form.task_priority_expr} onChange={e => set('task_priority_expr', e.target.value)} onFocus={() => setActiveField('task_priority_expr')} /></div>
                <div className="form-group"><label>Category</label><input value={form.task_category} onChange={e => set('task_category', e.target.value)} /></div>
                <div className="form-group"><label>Assign To Agent</label><input value={form.assigned_to_agent} onChange={e => set('assigned_to_agent', e.target.value)} /></div>
              </div>
              <div className="form-row-3">
                <div className="form-group"><label>Deadline Offset (min)</label><input type="number" value={form.deadline_offset_minutes} onChange={e => set('deadline_offset_minutes', e.target.value)} /></div>
                <div className="form-group"><label>Ext Ref Type</label><input id="tmpl-external_ref_type" value={form.external_ref_type} onChange={e => set('external_ref_type', e.target.value)} onFocus={() => setActiveField('external_ref_type')} /></div>
                <div className="form-group"><label>Ext Ref ID Expr</label><input id="tmpl-external_ref_id_expr" value={form.external_ref_id_expr} onChange={e => set('external_ref_id_expr', e.target.value)} onFocus={() => setActiveField('external_ref_id_expr')} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Tags (comma-sep)</label><input value={form.tags} onChange={e => set('tags', e.target.value)} /></div>
                <div className="form-group"><label>Enabled</label>
                  <label className="toggle"><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /><span className="toggle-slider" /></label>
                </div>
              </div>
            </div>
          </div>

          {/* Variable sidebar */}
          <SidebarPanel allVars={allVars} insertVar={insertVar} rawPayload={rawPayload} />
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Event Detail Modal ───────────────────────────────────────────────────────
function EventDetailModal({ event, onClose, onCreateTemplate }) {
  const vars = event.flattened_vars || (typeof event.payload === 'object' ? flattenObj(event.payload) : {});

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <h2>Webhook Event #{event.id}</h2>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:20}}>
          <div>
            <div className="section-title">Event Info</div>
            <div style={{fontSize:13, display:'grid', gap:6}}>
              <div><span style={{color:'var(--text-muted)'}}>Source:</span> {event.source_name || `#${event.source_id}`}</div>
              <div><span style={{color:'var(--text-muted)'}}>Status:</span> <span className={`badge badge-${event.processing_status}`}>{event.processing_status}</span></div>
              <div><span style={{color:'var(--text-muted)'}}>Time:</span> {new Date(event.created_at).toLocaleString()}</div>
              {event.matched_template_id && <div><span style={{color:'var(--text-muted)'}}>Template:</span> #{event.matched_template_id}</div>}
              {event.created_task_id && <div><span style={{color:'var(--text-muted)'}}>Task:</span> <Link to={`/tasks/${event.created_task_id}`}>#{event.created_task_id}</Link></div>}
              {event.error_message && <div className="error">{event.error_message}</div>}
            </div>
            <div className="section-title" style={{marginTop:16}}>Raw Payload</div>
            <pre>{JSON.stringify(typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload, null, 2)}</pre>
          </div>
          <div>
            <div className="section-title">Flattened Variables</div>
            <div className="var-list" style={{maxHeight:500}}>
              {Object.entries(vars).map(([k, v]) => (
                <div key={k} className="var-item">
                  <span className="var-name">{k}</span>
                  <span className="var-value">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                </div>
              ))}
              {Object.keys(vars).length === 0 && <div style={{fontSize:12,color:'var(--text-muted)',padding:8}}>No variables</div>}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          {event.processing_status === 'unmatched' && (
            <button className="btn-primary" onClick={() => onCreateTemplate(event)}>Create Template from This Event</button>
          )}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function flattenObj(obj, prefix = '') {
  const result = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      result[key] = v;
      result[`${key}.length`] = v.length;
      v.forEach((item, i) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          Object.assign(result, flattenObj(item, `${key}.${i}`));
        } else {
          result[`${key}.${i}`] = item;
        }
      });
    } else if (v && typeof v === 'object') {
      Object.assign(result, flattenObj(v, key));
    } else {
      result[key] = v;
    }
  }
  return result;
}

// ── Main Webhooks Page ───────────────────────────────────────────────────────
export default function Webhooks() {
  const [tab, setTab] = useState('sources');
  const { data: srcData, reload: reloadSrc } = useApi('/webhook-sources');
  const { data: tmplData, reload: reloadTmpl } = useApi('/webhook-templates');
  const { data: logData, reload: reloadLog } = useApi('/webhook-log?limit=100');
  const [editSource, setEditSource] = useState(undefined);
  const [editTemplate, setEditTemplate] = useState(undefined);
  const reloadAll = () => {
    // Don't reload while a modal is open — incoming webhooks would reset the form
    if (editSource !== undefined || editTemplate !== undefined) return;
    reloadSrc(); reloadTmpl(); reloadLog();
  };
  useSSE(reloadAll, ['webhook']);
  const [templateVars, setTemplateVars] = useState({});
  const [viewEvent, setViewEvent] = useState(null);

  const sources = srcData?.sources || [];
  const templates = tmplData?.templates || [];
  const events = logData?.events || [];
  const unmatched = events.filter(e => e.processing_status === 'unmatched');
  const { sorted: sortedTemplates, SortTh: TmplSortTh } = useSort(templates, TMPL_COLUMNS);
  const { sorted: sortedEvents, SortTh: LogSortTh } = useSort(events, LOG_COLUMNS);
  const { sorted: sortedUnmatched, SortTh: UnmSortTh } = useSort(unmatched, LOG_COLUMNS);

  async function deleteSource(id) { if (confirm('Delete this source?')) { await api.delete(`/webhook-sources/${id}`); reloadSrc(); } }
  async function deleteTemplate(id) { if (confirm('Delete this template?')) { await api.delete(`/webhook-templates/${id}`); reloadTmpl(); } }

  function createTemplateFromEvent(event) {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : (event.payload || {});
    const vars = flattenObj(payload);
    setTemplateVars({ vars, payload });
    setEditTemplate({
      _new: true,
      source_id: event.source_id,
      name: '',
      match_rules: [],
      task_title_template: '',
      task_description_template: '',
      task_priority_expr: '3',
      task_category: 'general',
    });
    setViewEvent(null);
    setTab('templates');
  }

  return (
    <div>
      <div className="page-header">
        <h1>Webhooks</h1>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'sources' ? 'active' : ''}`} onClick={() => setTab('sources')}>Sources ({sources.length})</button>
        <button className={`tab ${tab === 'templates' ? 'active' : ''}`} onClick={() => setTab('templates')}>Templates ({templates.length})</button>
        <button className={`tab ${tab === 'unmatched' ? 'active' : ''}`} onClick={() => setTab('unmatched')}>
          Unmatched {unmatched.length > 0 && <span className="badge badge-unmatched" style={{marginLeft:6}}>{unmatched.length}</span>}
        </button>
        <button className={`tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>Event Log</button>
      </div>

      {/* Sources */}
      {tab === 'sources' && (
        <>
          <div style={{marginBottom:16}}><button className="btn btn-primary btn-sm" onClick={() => setEditSource(null)}>+ New Source</button></div>
          <div className="card-grid" style={{gridTemplateColumns:'repeat(auto-fill, minmax(360px, 1fr))'}}>
            {sources.map(s => (
              <div key={s.id} className="card">
                <div className="flex-between mb-16">
                  <div><strong style={{fontSize:15}}>{s.name}</strong><div style={{fontSize:12,color:'var(--text-muted)'}}>{s.description}</div></div>
                  {s.enabled ? <span className="badge badge-healthy">active</span> : <span className="badge badge-cancelled">disabled</span>}
                </div>
                <div style={{background:'var(--bg-input)',padding:'6px 10px',borderRadius:4,fontSize:11,fontFamily:'monospace',marginBottom:12,wordBreak:'break-all'}}>
                  /webhooks/{s.slug}
                </div>
                <div style={{fontSize:12,color:'var(--text-dim)',marginBottom:12}}>
                  {s.secret ? 'HMAC: configured' : 'HMAC: none'}
                  {s.forward_url && <span style={{marginLeft:12}}>Forward: {s.forward_url}</span>}
                </div>
                <div className="btn-group">
                  <button className="btn btn-sm" onClick={() => setEditSource(s)}>Edit</button>
                  <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(`${window.location.protocol}//${window.location.hostname}:${window.location.port || 18790}/webhooks/${s.slug}`)}>Copy URL</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteSource(s.id)}>Delete</button>
                </div>
              </div>
            ))}
            {sources.length === 0 && <div className="empty" style={{gridColumn:'1/-1'}}>No webhook sources. Create one to start receiving events.</div>}
          </div>
          {editSource !== undefined && <SourceModal source={editSource} onClose={() => setEditSource(undefined)} onSaved={() => { setEditSource(undefined); reloadSrc(); }} />}
        </>
      )}

      {/* Templates */}
      {tab === 'templates' && (
        <>
          <div style={{marginBottom:16}}><button className="btn btn-primary btn-sm" onClick={() => { setTemplateVars({ vars: {}, payload: null }); setEditTemplate(null); }}>+ New Template</button></div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><TmplSortTh col="name">Name</TmplSortTh><TmplSortTh col="source">Source</TmplSortTh><th>Rules</th><th>Title Template</th><TmplSortTh col="category">Category</TmplSortTh><TmplSortTh col="assigned">Assigned</TmplSortTh><th>Enabled</th><th>Actions</th></tr></thead>
                <tbody>
                  {sortedTemplates.map(t => {
                    const rules = typeof t.match_rules === 'string' ? JSON.parse(t.match_rules) : (t.match_rules || []);
                    return (
                      <tr key={t.id}>
                        <td><strong>{t.name}</strong></td>
                        <td>{t.source_name || `#${t.source_id}`}</td>
                        <td>{rules.length > 0 ? rules.map((r, i) => <span key={i} className="tag" style={{marginBottom:2}}>{r.path} {r.op} {typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value)}</span>) : <span style={{color:'var(--text-muted)'}}>match all</span>}</td>
                        <td style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}><code>{t.task_title_template}</code></td>
                        <td><span className="tag">{t.task_category}</span></td>
                        <td>{t.assigned_to_agent || '—'}</td>
                        <td>{t.enabled ? <span className="badge badge-healthy">on</span> : <span className="badge badge-cancelled">off</span>}</td>
                        <td className="btn-group">
                          <button className="btn btn-sm" onClick={() => { setTemplateVars({ vars: {}, payload: null }); setEditTemplate(t); }}>Edit</button>
                          <button className="btn btn-sm btn-danger" onClick={() => deleteTemplate(t.id)}>Del</button>
                        </td>
                      </tr>
                    );
                  })}
                  {templates.length === 0 && <tr><td colSpan={8} className="empty">No templates. Create one or use the Unmatched tab to build from real events.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          {editTemplate !== undefined && (
            <TemplateModal
              template={editTemplate?._new ? null : editTemplate}
              sources={sources}
              vars={templateVars}
              onClose={() => setEditTemplate(undefined)}
              onSaved={() => { setEditTemplate(undefined); reloadTmpl(); }}
            />
          )}
        </>
      )}

      {/* Unmatched Events */}
      {tab === 'unmatched' && (
        <div>
          <div style={{marginBottom:16,fontSize:13,color:'var(--text-dim)'}}>
            Events that didn't match any template. Click an event to see its variables and create a template.
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><UnmSortTh col="time">Time</UnmSortTh><UnmSortTh col="source">Source</UnmSortTh><th>Event</th><th>Variables</th><th>Actions</th></tr></thead>
                <tbody>
                  {sortedUnmatched.map(e => {
                    const vars = e.flattened_vars || (typeof e.payload === 'object' ? flattenObj(e.payload) : {});
                    const varKeys = Object.keys(vars);
                    return (
                      <tr key={e.id}>
                        <td style={{fontSize:12,color:'var(--text-muted)',whiteSpace:'nowrap'}}>{timeAgo(e.created_at)}</td>
                        <td>{e.source_name || `#${e.source_id}`}</td>
                        <td><code>{vars.event || vars.type || vars.action || '—'}</code></td>
                        <td>{varKeys.slice(0, 5).map(k => <span key={k} className="tag">{k}</span>)}{varKeys.length > 5 && <span className="tag">+{varKeys.length - 5} more</span>}</td>
                        <td className="btn-group">
                          <button className="btn btn-sm" onClick={() => setViewEvent(e)}>View</button>
                          <button className="btn btn-sm btn-primary" onClick={() => createTemplateFromEvent(e)}>Create Template</button>
                        </td>
                      </tr>
                    );
                  })}
                  {unmatched.length === 0 && <tr><td colSpan={5} className="empty">No unmatched events. All incoming webhooks are being handled by templates.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Event Log */}
      {tab === 'log' && (
        <div>
          <div style={{marginBottom:12}}><button className="btn btn-sm" onClick={reloadLog}>Refresh</button></div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><LogSortTh col="time">Time</LogSortTh><LogSortTh col="source">Source</LogSortTh><LogSortTh col="status">Status</LogSortTh><LogSortTh col="template">Template</LogSortTh><LogSortTh col="task">Task</LogSortTh><th>Actions</th></tr></thead>
                <tbody>
                  {sortedEvents.map(e => (
                    <tr key={e.id}>
                      <td style={{fontSize:12,color:'var(--text-muted)',whiteSpace:'nowrap'}}>{timeAgo(e.created_at)}</td>
                      <td>{e.source_name || `#${e.source_id}`}</td>
                      <td><span className={`badge badge-${e.processing_status}`}>{e.processing_status}</span></td>
                      <td>{e.matched_template_id ? `#${e.matched_template_id}` : '—'}</td>
                      <td>{e.created_task_id ? <Link to={`/tasks/${e.created_task_id}`}>#{e.created_task_id}</Link> : '—'}</td>
                      <td><button className="btn btn-sm" onClick={() => setViewEvent(e)}>View</button></td>
                    </tr>
                  ))}
                  {events.length === 0 && <tr><td colSpan={6} className="empty">No webhook events received yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {viewEvent && <EventDetailModal event={viewEvent} onClose={() => setViewEvent(null)} onCreateTemplate={createTemplateFromEvent} />}
    </div>
  );
}

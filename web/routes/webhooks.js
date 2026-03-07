'use strict';
const { Router } = require('express');
const { flattenPayload, evaluateMatchRules, renderTemplate } = require('../../lib/webhook-templates');

module.exports = function ({ db, eventBus }) {
  const r = Router();

  // ── Webhook Sources ────────────────────────────────────────────────────────

  r.get('/webhook-sources', async (req, res) => {
    try {
      const sources = await db.getMany('SELECT * FROM webhook_sources ORDER BY name');
      res.json({ sources });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/webhook-sources/:id', async (req, res) => {
    try {
      const src = await db.getOne('SELECT * FROM webhook_sources WHERE id = $1', [req.params.id]);
      if (!src) return res.status(404).json({ error: 'Source not found' });
      const templates = await db.getMany(
        'SELECT * FROM webhook_templates WHERE source_id = $1 ORDER BY name', [src.id]);
      const recentEvents = await db.getMany(
        'SELECT * FROM webhook_log WHERE source_id = $1 ORDER BY created_at DESC LIMIT 20', [src.id]);
      res.json({ source: src, templates, recent_events: recentEvents });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/webhook-sources', async (req, res) => {
    try {
      const b = req.body;
      if (!b.name || !b.slug) return res.status(400).json({ error: 'name and slug required' });
      const src = await db.insert('webhook_sources', {
        name: b.name, slug: b.slug, description: b.description || null,
        secret: b.secret || null, enabled: b.enabled !== false,
        forward_url: b.forward_url || null,
        forward_headers: b.forward_headers ? JSON.stringify(b.forward_headers) : '{}',
        headers_to_extract: b.headers_to_extract ? `{${b.headers_to_extract.join(',')}}` : '{}',
      });
      if (eventBus) eventBus.emit('webhook', { action: 'source_created', id: src.id });
      res.status(201).json(src);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.put('/webhook-sources/:id', async (req, res) => {
    try {
      const fields = {};
      ['name', 'slug', 'description', 'secret', 'enabled', 'forward_url'].forEach(k => {
        if (req.body[k] !== undefined) fields[k] = req.body[k];
      });
      if (req.body.forward_headers) fields.forward_headers = JSON.stringify(req.body.forward_headers);
      if (req.body.headers_to_extract) fields.headers_to_extract = `{${req.body.headers_to_extract.join(',')}}`;
      if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields' });
      const rows = await db.update('webhook_sources', fields, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Source not found' });
      if (eventBus) eventBus.emit('webhook', { action: 'source_updated', id: rows[0].id });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.delete('/webhook-sources/:id', async (req, res) => {
    try {
      const count = await db.delete('webhook_sources', 'id = $1', [req.params.id]);
      if (eventBus) eventBus.emit('webhook', { action: 'source_deleted', id: parseInt(req.params.id) });
      res.json({ deleted: count });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Webhook Templates ─────────────────────────────────────────────────────

  r.get('/webhook-templates', async (req, res) => {
    try {
      const { source_id } = req.query;
      let templates;
      if (source_id) {
        templates = await db.getMany(
          `SELECT wt.*, ws.name AS source_name FROM webhook_templates wt
           LEFT JOIN webhook_sources ws ON ws.id = wt.source_id
           WHERE wt.source_id = $1 ORDER BY wt.name`, [parseInt(source_id)]);
      } else {
        templates = await db.getMany(
          `SELECT wt.*, ws.name AS source_name FROM webhook_templates wt
           LEFT JOIN webhook_sources ws ON ws.id = wt.source_id ORDER BY ws.name, wt.name`);
      }
      res.json({ templates });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/webhook-templates/:id', async (req, res) => {
    try {
      const tmpl = await db.getOne(
        `SELECT wt.*, ws.name AS source_name FROM webhook_templates wt
         LEFT JOIN webhook_sources ws ON ws.id = wt.source_id WHERE wt.id = $1`, [req.params.id]);
      if (!tmpl) return res.status(404).json({ error: 'Template not found' });
      res.json(tmpl);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/webhook-templates', async (req, res) => {
    try {
      const b = req.body;
      if (!b.source_id || !b.name || !b.task_title_template) {
        return res.status(400).json({ error: 'source_id, name, task_title_template required' });
      }
      const tmpl = await db.insert('webhook_templates', {
        source_id: b.source_id, name: b.name, enabled: b.enabled !== false,
        match_rules: JSON.stringify(b.match_rules || []),
        task_title_template: b.task_title_template,
        task_description_template: b.task_description_template || null,
        task_priority_expr: b.task_priority_expr || '3',
        task_category: b.task_category || 'general',
        assigned_to_agent: b.assigned_to_agent || null,
        deadline_offset_minutes: b.deadline_offset_minutes || null,
        external_ref_type: b.external_ref_type || null,
        external_ref_id_expr: b.external_ref_id_expr || null,
        tags: b.tags ? `{${b.tags.join(',')}}` : '{}',
        after_hours_auth: b.after_hours_auth || false,
      });
      if (eventBus) eventBus.emit('webhook', { action: 'template_created', id: tmpl.id });
      res.status(201).json(tmpl);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.put('/webhook-templates/:id', async (req, res) => {
    try {
      const fields = {};
      ['source_id', 'name', 'enabled', 'task_title_template', 'task_description_template',
       'task_priority_expr', 'task_category', 'assigned_to_agent',
       'deadline_offset_minutes', 'external_ref_type', 'external_ref_id_expr', 'after_hours_auth'
      ].forEach(k => { if (req.body[k] !== undefined) fields[k] = req.body[k]; });
      if (req.body.match_rules !== undefined) fields.match_rules = JSON.stringify(req.body.match_rules);
      if (req.body.tags !== undefined) fields.tags = `{${req.body.tags.join(',')}}`;
      if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields' });
      const rows = await db.update('webhook_templates', fields, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
      if (eventBus) eventBus.emit('webhook', { action: 'template_updated', id: rows[0].id });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.delete('/webhook-templates/:id', async (req, res) => {
    try {
      const count = await db.delete('webhook_templates', 'id = $1', [req.params.id]);
      if (eventBus) eventBus.emit('webhook', { action: 'template_deleted', id: parseInt(req.params.id) });
      res.json({ deleted: count });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Template test (dry-run) ───────────────────────────────────────────────

  r.post('/webhook-templates/test', async (req, res) => {
    try {
      const { template_id, payload, source_id } = req.body;
      if (!payload) return res.status(400).json({ error: 'payload required' });

      const vars = flattenPayload(payload);

      if (template_id) {
        // Test specific template
        const tmpl = await db.getOne('SELECT * FROM webhook_templates WHERE id = $1', [template_id]);
        if (!tmpl) return res.status(404).json({ error: 'Template not found' });
        const rules = typeof tmpl.match_rules === 'string' ? JSON.parse(tmpl.match_rules) : tmpl.match_rules;
        const matched = evaluateMatchRules(rules, vars);
        const preview = matched ? {
          title: renderTemplate(tmpl.task_title_template, vars),
          description: renderTemplate(tmpl.task_description_template || '', vars),
          priority: renderTemplate(tmpl.task_priority_expr || '3', vars),
          category: tmpl.task_category,
          assigned_to: tmpl.assigned_to_agent,
        } : null;
        res.json({ matched, flattened_vars: vars, task_preview: preview });
      } else if (source_id) {
        // Test all templates for a source
        const templates = await db.getMany(
          'SELECT * FROM webhook_templates WHERE source_id = $1 AND enabled = TRUE', [parseInt(source_id)]);
        const results = templates.map(tmpl => {
          const rules = typeof tmpl.match_rules === 'string' ? JSON.parse(tmpl.match_rules) : tmpl.match_rules;
          const matched = evaluateMatchRules(rules, vars);
          return {
            template_id: tmpl.id, template_name: tmpl.name, matched,
            task_preview: matched ? {
              title: renderTemplate(tmpl.task_title_template, vars),
              description: renderTemplate(tmpl.task_description_template || '', vars),
            } : null,
          };
        });
        res.json({ flattened_vars: vars, results });
      } else {
        // Just flatten the payload
        res.json({ flattened_vars: vars });
      }
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Webhook Log ───────────────────────────────────────────────────────────

  r.get('/webhook-log', async (req, res) => {
    try {
      const { source_id, processing_status, unmatched_only, limit = 50, offset = 0 } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (source_id)         { conditions.push(`wl.source_id = $${idx++}`); params.push(parseInt(source_id)); }
      if (processing_status) { conditions.push(`wl.processing_status = $${idx++}`); params.push(processing_status); }
      if (unmatched_only === 'true') { conditions.push(`wl.processing_status = 'unmatched'`); }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      params.push(Math.min(parseInt(limit), 200), parseInt(offset));

      const logs = await db.getMany(
        `SELECT wl.*, ws.name AS source_name FROM webhook_log wl
         LEFT JOIN webhook_sources ws ON ws.id = wl.source_id
         ${where} ORDER BY wl.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        params
      );
      res.json({ events: logs, count: logs.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/webhook-log/:id', async (req, res) => {
    try {
      const entry = await db.getOne(
        `SELECT wl.*, ws.name AS source_name FROM webhook_log wl
         LEFT JOIN webhook_sources ws ON ws.id = wl.source_id WHERE wl.id = $1`, [req.params.id]);
      if (!entry) return res.status(404).json({ error: 'Log entry not found' });
      // If a task was created, fetch it
      let task = null;
      if (entry.created_task_id) {
        task = await db.getOne('SELECT * FROM tasks WHERE id = $1', [entry.created_task_id]);
      }
      res.json({ event: entry, created_task: task });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

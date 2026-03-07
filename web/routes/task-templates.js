'use strict';
const { Router } = require('express');

module.exports = function ({ db, eventBus, logger }) {
  const r = Router();

  // ── List all task templates ──────────────────────────────────────────────
  r.get('/task-templates', async (req, res) => {
    try {
      const templates = await db.getMany(
        'SELECT * FROM task_templates ORDER BY created_at DESC'
      );
      res.json({ templates, total: templates.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Create task template ─────────────────────────────────────────────────
  r.post('/task-templates', async (req, res) => {
    try {
      const b = req.body;
      if (!b.name || !b.schedule_expr || !b.task_title_template) {
        return res.status(400).json({ error: 'name, schedule_expr, task_title_template required' });
      }
      const data = {
        name: b.name,
        enabled: b.enabled !== false,
        run_once: b.run_once || false,
        schedule_expr: b.schedule_expr,
        schedule_tz: b.schedule_tz || 'America/Toronto',
        task_title_template: b.task_title_template,
        task_description_template: b.task_description_template || null,
        task_priority: b.task_priority || 3,
        task_category: b.task_category || 'general',
        assigned_to_agent: b.assigned_to_agent || null,
        deadline_offset_minutes: b.deadline_offset_minutes || null,
        tags: b.tags ? `{${(Array.isArray(b.tags) ? b.tags : [b.tags]).join(',')}}` : '{}',
        after_hours_auth: b.after_hours_auth || false,
        metadata: JSON.stringify(b.metadata || {}),
      };
      const row = await db.insert('task_templates', data);
      if (eventBus) eventBus.emit('cron', { action: 'template_created', id: row.id });
      res.status(201).json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Update task template ─────────────────────────────────────────────────
  r.put('/task-templates/:id', async (req, res) => {
    try {
      const b = req.body;
      const updates = {};
      if (b.name !== undefined)                    updates.name = b.name;
      if (b.enabled !== undefined)                 updates.enabled = b.enabled;
      if (b.run_once !== undefined)                updates.run_once = b.run_once;
      if (b.schedule_expr !== undefined)           updates.schedule_expr = b.schedule_expr;
      if (b.schedule_tz !== undefined)             updates.schedule_tz = b.schedule_tz;
      if (b.task_title_template !== undefined)     updates.task_title_template = b.task_title_template;
      if (b.task_description_template !== undefined) updates.task_description_template = b.task_description_template;
      if (b.task_priority !== undefined)           updates.task_priority = b.task_priority;
      if (b.task_category !== undefined)           updates.task_category = b.task_category;
      if (b.assigned_to_agent !== undefined)       updates.assigned_to_agent = b.assigned_to_agent || null;
      if (b.deadline_offset_minutes !== undefined) updates.deadline_offset_minutes = b.deadline_offset_minutes || null;
      if (b.after_hours_auth !== undefined)        updates.after_hours_auth = b.after_hours_auth;
      if (b.tags !== undefined) updates.tags = `{${(Array.isArray(b.tags) ? b.tags : [b.tags]).join(',')}}`;
      if (b.metadata !== undefined) updates.metadata = JSON.stringify(b.metadata);

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const rows = await db.update('task_templates', updates, 'id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Template not found' });
      if (eventBus) eventBus.emit('cron', { action: 'template_updated', id: parseInt(req.params.id) });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Delete task template ─────────────────────────────────────────────────
  r.delete('/task-templates/:id', async (req, res) => {
    try {
      const count = await db.delete('task_templates', 'id = $1', [req.params.id]);
      if (!count) return res.status(404).json({ error: 'Template not found' });
      if (eventBus) eventBus.emit('cron', { action: 'template_deleted', id: parseInt(req.params.id) });
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Toggle enabled ───────────────────────────────────────────────────────
  r.patch('/task-templates/:id/toggle', async (req, res) => {
    try {
      const existing = await db.getOne('SELECT * FROM task_templates WHERE id = $1', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Template not found' });
      const rows = await db.update('task_templates', { enabled: !existing.enabled }, 'id = $1', [req.params.id]);
      if (eventBus) eventBus.emit('cron', { action: 'template_toggled', id: parseInt(req.params.id) });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

'use strict';
const { Router } = require('express');

module.exports = function ({ db, eventBus }) {
  const r = Router();

  // Escalation history
  r.get('/escalations', async (req, res) => {
    try {
      const { task_id, status, limit = 50, offset = 0 } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (task_id) { conditions.push(`eh.task_id = $${idx++}`); params.push(parseInt(task_id)); }
      if (status)  { conditions.push(`eh.status = $${idx++}`); params.push(status); }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      params.push(Math.min(parseInt(limit), 200), parseInt(offset));

      const history = await db.getMany(
        `SELECT eh.*, t.title AS task_title, er.name AS rule_name
         FROM escalation_history eh
         LEFT JOIN tasks t ON t.id = eh.task_id
         LEFT JOIN escalation_rules er ON er.id = eh.rule_id
         ${where} ORDER BY eh.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        params
      );
      res.json({ escalations: history, count: history.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/escalations/:id/ack', async (req, res) => {
    try {
      const rows = await db.update('escalation_history', {
        status: 'acknowledged', response_received: req.body.message || 'Acknowledged',
        response_at: new Date().toISOString(),
      }, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Escalation not found' });
      if (eventBus) eventBus.emit('escalation', { action: 'acknowledged', id: parseInt(req.params.id) });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/escalations/:id/resolve', async (req, res) => {
    try {
      const rows = await db.update('escalation_history', {
        status: 'resolved', response_received: req.body.message || 'Resolved',
        response_at: new Date().toISOString(),
      }, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Escalation not found' });
      if (eventBus) eventBus.emit('escalation', { action: 'resolved', id: parseInt(req.params.id) });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Escalation rules
  r.get('/escalation-rules', async (req, res) => {
    try {
      const rules = await db.getMany('SELECT * FROM escalation_rules ORDER BY id');
      res.json({ rules });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/escalation-rules', async (req, res) => {
    try {
      const b = req.body;
      if (!b.name || !b.trigger_condition || !b.to_agent) {
        return res.status(400).json({ error: 'name, trigger_condition, to_agent required' });
      }
      const rule = await db.insert('escalation_rules', {
        name: b.name, trigger_condition: b.trigger_condition,
        task_category: b.task_category || null, from_agent: b.from_agent || null,
        to_agent: b.to_agent, timeout_minutes: b.timeout_minutes || null,
        sms_template: b.sms_template || null, enabled: b.enabled !== false,
        cooldown_minutes: b.cooldown_minutes || 30, max_escalations: b.max_escalations || 3,
        priority_override: b.priority_override || null,
      });
      if (eventBus) eventBus.emit('rule', { action: 'created', id: rule.id });
      res.status(201).json(rule);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.put('/escalation-rules/:id', async (req, res) => {
    try {
      const fields = {};
      ['name', 'trigger_condition', 'task_category', 'from_agent', 'to_agent',
       'timeout_minutes', 'sms_template', 'enabled', 'cooldown_minutes',
       'max_escalations', 'priority_override'
      ].forEach(k => { if (req.body[k] !== undefined) fields[k] = req.body[k]; });
      if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields' });
      const rows = await db.update('escalation_rules', fields, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Rule not found' });
      if (eventBus) eventBus.emit('rule', { action: 'updated', id: rows[0].id });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.delete('/escalation-rules/:id', async (req, res) => {
    try {
      const count = await db.delete('escalation_rules', 'id = $1', [req.params.id]);
      if (eventBus) eventBus.emit('rule', { action: 'deleted', id: parseInt(req.params.id) });
      res.json({ deleted: count });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

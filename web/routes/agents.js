'use strict';
const { Router } = require('express');

module.exports = function ({ db, eventBus }) {
  const r = Router();

  r.get('/agents', async (req, res) => {
    try {
      const agents = await db.getMany('SELECT * FROM agent_availability ORDER BY agent_id');
      // Attach task counts
      for (const agent of agents) {
        agent.active_task_count = await db.getCount(
          `SELECT COUNT(*) AS count FROM tasks WHERE assigned_to_agent = $1 AND status IN ('todo','in_progress','blocked')`,
          [agent.agent_id]
        );
      }
      res.json({ agents });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/agents/available', async (req, res) => {
    try {
      const agents = await db.getMany(
        `SELECT * FROM agent_availability WHERE current_status = 'available' ORDER BY agent_id`
      );
      res.json({ agents });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/agents/:id', async (req, res) => {
    try {
      const agent = await db.getOne('SELECT * FROM agent_availability WHERE agent_id = $1', [req.params.id]);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const tasks = await db.getMany(
        `SELECT id, title, status, priority, deadline FROM tasks
         WHERE assigned_to_agent = $1 AND status IN ('todo','in_progress','blocked')
         ORDER BY priority ASC`, [req.params.id]
      );
      res.json({ agent, active_tasks: tasks });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.put('/agents/:id', async (req, res) => {
    try {
      const b = req.body;
      const fields = {};
      ['display_name', 'working_hours_start', 'working_hours_end', 'timezone',
       'after_hours_capable', 'max_concurrent_tasks', 'current_status', 'reports_to'
      ].forEach(k => { if (b[k] !== undefined) fields[k] = b[k]; });
      if (b.working_days) fields.working_days = `{${b.working_days.join(',')}}`;
      if (b.capabilities) fields.capabilities = `{${b.capabilities.join(',')}}`;

      const existing = await db.getOne('SELECT * FROM agent_availability WHERE agent_id = $1', [req.params.id]);
      if (existing) {
        if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields' });
        const rows = await db.update('agent_availability', fields, 'agent_id = $1', [req.params.id]);
        if (eventBus) eventBus.emit('agent', { action: 'updated', id: req.params.id });
        res.json(rows[0]);
      } else {
        fields.agent_id = req.params.id;
        const row = await db.insert('agent_availability', fields);
        if (eventBus) eventBus.emit('agent', { action: 'created', id: req.params.id });
        res.status(201).json(row);
      }
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.patch('/agents/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'status required' });
      const existing = await db.getOne('SELECT * FROM agent_availability WHERE agent_id = $1', [req.params.id]);
      if (existing) {
        const rows = await db.update('agent_availability', {
          current_status: status, last_heartbeat: new Date().toISOString()
        }, 'agent_id = $1', [req.params.id]);
        if (eventBus) eventBus.emit('agent', { action: 'status_changed', id: req.params.id });
        res.json(rows[0]);
      } else {
        const row = await db.insert('agent_availability', {
          agent_id: req.params.id, current_status: status, last_heartbeat: new Date().toISOString()
        });
        if (eventBus) eventBus.emit('agent', { action: 'status_changed', id: req.params.id });
        res.status(201).json(row);
      }
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

'use strict';
const { Router } = require('express');

module.exports = function ({ db, eventBus }) {
  const r = Router();

  r.get('/worklogs', async (req, res) => {
    try {
      const { task_id, agent_id, action, date_from, date_to, limit = 50, offset = 0 } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (task_id)   { conditions.push(`wl.task_id = $${idx++}`); params.push(parseInt(task_id)); }
      if (agent_id)  { conditions.push(`wl.agent_id = $${idx++}`); params.push(agent_id); }
      if (action)    { conditions.push(`wl.action = $${idx++}`); params.push(action); }
      if (date_from) { conditions.push(`wl.created_at >= $${idx++}`); params.push(date_from); }
      if (date_to)   { conditions.push(`wl.created_at <= $${idx++}`); params.push(date_to); }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      params.push(Math.min(parseInt(limit), 200), parseInt(offset));

      const logs = await db.getMany(
        `SELECT wl.*, t.title AS task_title FROM work_logs wl
         LEFT JOIN tasks t ON t.id = wl.task_id ${where}
         ORDER BY wl.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        params
      );
      res.json({ work_logs: logs, count: logs.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/worklogs', async (req, res) => {
    try {
      const b = req.body;
      if (!b.task_id) return res.status(400).json({ error: 'task_id required' });
      const entry = await db.insert('work_logs', {
        task_id: b.task_id, agent_id: b.agent_id || 'human',
        action: b.action || 'note', notes: b.notes || null,
        time_spent_minutes: b.time_spent_minutes || 0,
        status_from: b.status_from || null, status_to: b.status_to || null,
        metadata: b.metadata ? JSON.stringify(b.metadata) : '{}',
      });
      if (b.time_spent_minutes && b.time_spent_minutes > 0) {
        await db.query('UPDATE tasks SET actual_minutes = COALESCE(actual_minutes,0) + $1 WHERE id = $2',
          [b.time_spent_minutes, b.task_id]);
      }
      if (eventBus) eventBus.emit('worklog', { action: 'created', id: entry.id });
      res.status(201).json(entry);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/worklogs/report', async (req, res) => {
    try {
      const { group_by = 'agent', agent_id, date_from, date_to } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (agent_id)  { conditions.push(`wl.agent_id = $${idx++}`); params.push(agent_id); }
      if (date_from) { conditions.push(`wl.created_at >= $${idx++}`); params.push(date_from); }
      if (date_to)   { conditions.push(`wl.created_at <= $${idx++}`); params.push(date_to); }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      const queries = {
        agent:    `SELECT wl.agent_id, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries FROM work_logs wl ${where} GROUP BY wl.agent_id ORDER BY total_minutes DESC`,
        task:     `SELECT wl.task_id, t.title, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries FROM work_logs wl LEFT JOIN tasks t ON t.id = wl.task_id ${where} GROUP BY wl.task_id, t.title ORDER BY total_minutes DESC`,
        category: `SELECT t.category, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries FROM work_logs wl LEFT JOIN tasks t ON t.id = wl.task_id ${where} GROUP BY t.category ORDER BY total_minutes DESC`,
        date:     `SELECT DATE(wl.created_at) AS date, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries FROM work_logs wl ${where} GROUP BY DATE(wl.created_at) ORDER BY date DESC`,
      };

      const report = await db.getMany(queries[group_by] || queries.agent, params);
      res.json({ report, group_by });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

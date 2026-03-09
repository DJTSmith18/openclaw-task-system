'use strict';
const { Router } = require('express');

module.exports = function ({ db }) {
  const r = Router();

  // Aggregated dashboard data (single call)
  r.get('/dashboard', async (req, res) => {
    try {
      const [byStatus, byPriority, byAgent, overdue, unassigned, recentActivity, agents, pendingEscalations] = await Promise.all([
        db.getMany('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status'),
        db.getMany(`SELECT priority, COUNT(*) AS count FROM tasks WHERE status NOT IN ('done','cancelled') GROUP BY priority`),
        db.getMany(`SELECT assigned_to_agent, COUNT(*) AS count FROM tasks WHERE assigned_to_agent IS NOT NULL AND status NOT IN ('done','cancelled') GROUP BY assigned_to_agent ORDER BY count DESC`),
        db.getCount(`SELECT COUNT(*) AS count FROM tasks WHERE deadline < NOW() AND status IN ('todo','in_progress','blocked','unblocked')`),
        db.getCount(`SELECT COUNT(*) AS count FROM tasks WHERE assigned_to_agent IS NULL AND status IN ('todo','in_progress','unblocked')`),
        db.getMany(`SELECT wl.*, t.title AS task_title FROM work_logs wl LEFT JOIN tasks t ON t.id = wl.task_id ORDER BY wl.created_at DESC LIMIT 20`),
        db.getMany('SELECT * FROM agent_availability ORDER BY agent_id'),
        db.getCount(`SELECT COUNT(*) AS count FROM escalation_history WHERE status = 'pending'`),
      ]);

      // Today's time
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayTime = await db.getOne(
        `SELECT COALESCE(SUM(time_spent_minutes), 0) AS total FROM work_logs WHERE created_at >= $1`,
        [todayStart.toISOString()]
      );

      res.json({
        tasks: { by_status: byStatus, by_priority: byPriority, by_agent: byAgent, overdue, unassigned },
        agents,
        recent_activity: recentActivity,
        pending_escalations: pendingEscalations,
        today_minutes: parseInt(todayTime?.total || '0', 10),
        timestamp: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/dashboard/timeline', async (req, res) => {
    try {
      const { limit = 50 } = req.query;
      const events = await db.getMany(
        `SELECT wl.*, t.title AS task_title FROM work_logs wl
         LEFT JOIN tasks t ON t.id = wl.task_id
         ORDER BY wl.created_at DESC LIMIT $1`,
        [Math.min(parseInt(limit), 200)]
      );
      res.json({ events });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/dashboard/metrics', async (req, res) => {
    try {
      const days = parseInt(req.query.days || '7');
      const since = new Date(Date.now() - days * 86400000).toISOString();

      const [total, completed, created, avgRes] = await Promise.all([
        db.getCount('SELECT COUNT(*) AS count FROM tasks'),
        db.getCount(`SELECT COUNT(*) AS count FROM tasks WHERE status = 'done' AND updated_at >= $1`, [since]),
        db.getCount(`SELECT COUNT(*) AS count FROM tasks WHERE created_at >= $1`, [since]),
        db.getOne(`SELECT AVG(actual_minutes) AS avg FROM tasks WHERE status = 'done' AND actual_minutes > 0 AND updated_at >= $1`, [since]),
      ]);

      res.json({
        period_days: days, total_tasks: total,
        created_in_period: created, completed_in_period: completed,
        completion_rate: created > 0 ? `${(completed / created * 100).toFixed(1)}%` : 'N/A',
        avg_resolution_minutes: avgRes?.avg ? Math.round(parseFloat(avgRes.avg)) : null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

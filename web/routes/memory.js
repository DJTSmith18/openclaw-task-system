'use strict';
const { Router } = require('express');

module.exports = function ({ db }) {
  const r = Router();

  // ── Active observations ──────────────────────────────────────────────────────
  r.get('/memory/observations', async (req, res) => {
    try {
      const { agent_id, source, min_importance, limit = 100, offset = 0 } = req.query;
      const conditions = ['archived_at IS NULL'];
      const params = [];
      let idx = 1;

      if (agent_id) { conditions.push(`agent_id = $${idx++}`); params.push(agent_id); }
      if (source) { conditions.push(`source = $${idx++}`); params.push(source); }
      if (min_importance) { conditions.push(`importance >= $${idx++}`); params.push(parseFloat(min_importance)); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await db.getMany(
        `SELECT id, agent_id, source, content, obs_type, importance, tags, metadata, expires_at, created_at
         FROM observations ${where}
         ORDER BY importance DESC, created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, parseInt(limit), parseInt(offset)]
      );
      const total = await db.getCount(
        `SELECT COUNT(*) AS count FROM observations ${where}`, params
      );
      res.json({ observations: rows, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Archived observations ────────────────────────────────────────────────────
  r.get('/memory/observations/archived', async (req, res) => {
    try {
      const { agent_id, limit = 50 } = req.query;
      const conditions = ['archived_at IS NOT NULL'];
      const params = [];
      let idx = 1;
      if (agent_id) { conditions.push(`agent_id = $${idx++}`); params.push(agent_id); }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const rows = await db.getMany(
        `SELECT id, agent_id, source, content, obs_type, importance, tags, archived_at, created_at
         FROM observations ${where}
         ORDER BY archived_at DESC LIMIT $${idx++}`,
        [...params, parseInt(limit)]
      );
      res.json({ observations: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Long-term memory ────────────────────────────────────────────────────────
  r.get('/memory/long-term', async (req, res) => {
    try {
      const { agent_id, category } = req.query;
      const conditions = ['superseded_by IS NULL'];
      const params = [];
      let idx = 1;
      if (agent_id) { conditions.push(`agent_id = $${idx++}`); params.push(agent_id); }
      if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const rows = await db.getMany(
        `SELECT * FROM memory_long_term ${where} ORDER BY created_at DESC`, params
      );
      res.json({ entries: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Dream log ───────────────────────────────────────────────────────────────
  r.get('/memory/dream-log', async (req, res) => {
    try {
      const { agent_id, limit = 50 } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;
      if (agent_id) { conditions.push(`agent_id = $${idx++}`); params.push(agent_id); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await db.getMany(
        `SELECT * FROM dream_log ${where} ORDER BY created_at DESC LIMIT $${idx++}`,
        [...params, parseInt(limit)]
      );
      res.json({ logs: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Memory stats ──────────────────────────────────────────────────────────────
  r.get('/memory/stats', async (req, res) => {
    try {
      const { agent_id } = req.query;
      const agentFilter = agent_id ? 'WHERE agent_id = $1' : '';
      const params = agent_id ? [agent_id] : [];

      const active = await db.getCount(`SELECT COUNT(*) AS count FROM observations ${agentFilter ? agentFilter + ' AND' : 'WHERE'} archived_at IS NULL`, params);
      const archived = await db.getCount(`SELECT COUNT(*) AS count FROM observations ${agentFilter ? agentFilter + ' AND' : 'WHERE'} archived_at IS NOT NULL`, params);
      const longTerm = await db.getCount(`SELECT COUNT(*) AS count FROM memory_long_term ${agentFilter ? agentFilter + ' AND' : 'WHERE'} superseded_by IS NULL`, params);
      const lastCycle = await db.getOne(`SELECT * FROM dream_log ${agentFilter} ORDER BY created_at DESC LIMIT 1`, params);

      // Per-agent breakdown
      const agents = await db.getMany(
        `SELECT agent_id,
                COUNT(*) FILTER (WHERE archived_at IS NULL) AS active,
                COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived
         FROM observations ${agentFilter} GROUP BY agent_id ORDER BY agent_id`, params
      );

      res.json({ active_observations: active, archived_observations: archived, long_term_entries: longTerm, last_cycle: lastCycle, agents });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

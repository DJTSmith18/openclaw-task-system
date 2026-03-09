'use strict';
const { Router } = require('express');

module.exports = function ({ db, eventBus }) {
  const r = Router();

  // List tasks (with filters)
  r.get('/tasks', async (req, res) => {
    try {
      const { status, priority, category, assigned_to, search, limit = 50, offset = 0 } = req.query;
      const conditions = [];
      const params = [];
      let idx = 1;

      if (status)      { conditions.push(`status = $${idx++}`); params.push(status); }
      if (priority)    { conditions.push(`priority = $${idx++}`); params.push(parseInt(priority)); }
      if (category)    { conditions.push(`category = $${idx++}`); params.push(category); }
      if (assigned_to) { conditions.push(`assigned_to_agent = $${idx++}`); params.push(assigned_to); }
      if (search)      { conditions.push(`(title ILIKE $${idx} OR description ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      params.push(Math.min(parseInt(limit), 200), parseInt(offset));

      const tasks = await db.getMany(
        `SELECT * FROM tasks ${where} ORDER BY priority ASC, deadline ASC NULLS LAST, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        params
      );
      const total = await db.getCount(`SELECT COUNT(*) AS count FROM tasks ${where}`, params.slice(0, -2));

      res.json({ tasks, total, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get task summary stats
  r.get('/tasks/summary', async (req, res) => {
    try {
      const byStatus = await db.getMany('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status');
      const byPriority = await db.getMany(
        `SELECT priority, COUNT(*) AS count FROM tasks WHERE status NOT IN ('done','cancelled') GROUP BY priority`
      );
      const overdue = await db.getCount(
        `SELECT COUNT(*) AS count FROM tasks WHERE deadline < NOW() AND status IN ('todo','in_progress','blocked','unblocked')`
      );
      const unassigned = await db.getCount(
        `SELECT COUNT(*) AS count FROM tasks WHERE assigned_to_agent IS NULL AND status IN ('todo','in_progress','unblocked')`
      );
      res.json({ by_status: byStatus, by_priority: byPriority, overdue, unassigned });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Search tasks
  r.get('/tasks/search', async (req, res) => {
    try {
      const { q, limit = 50, offset = 0 } = req.query;
      if (!q) return res.status(400).json({ error: 'q parameter required' });
      const tasks = await db.getMany(
        `SELECT * FROM tasks WHERE title ILIKE $1 OR description ILIKE $1 OR category ILIKE $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [`%${q}%`, Math.min(parseInt(limit), 200), parseInt(offset)]
      );
      res.json({ tasks, count: tasks.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Create task
  r.post('/tasks', async (req, res) => {
    try {
      const b = req.body;
      if (!b.title) return res.status(400).json({ error: 'title required' });
      const task = await db.insert('tasks', {
        title: b.title, description: b.description || null,
        status: b.status || 'todo', priority: b.priority || 3,
        category: b.category || 'general',
        created_by_agent: b.created_by_agent || 'human',
        assigned_to_agent: b.assigned_to_agent || null,
        assigned_at: b.assigned_to_agent ? new Date().toISOString() : null,
        deadline: b.deadline || null, estimated_minutes: b.estimated_minutes || null,
        external_ref_type: b.external_ref_type || null, external_ref_id: b.external_ref_id || null,
        after_hours_auth: b.after_hours_auth || false,
        parent_task_id: b.parent_task_id || null,
        tags: b.tags ? `{${b.tags.join(',')}}` : '{}',
        metadata: b.metadata ? JSON.stringify(b.metadata) : '{}',
      });
      await db.insert('work_logs', {
        task_id: task.id, agent_id: b.created_by_agent || 'human',
        action: 'status_change', status_to: task.status, notes: 'Task created via Web UI',
      });
      if (eventBus) eventBus.emit('task', { action: 'created', id: task.id });
      res.status(201).json(task);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get single task
  r.get('/tasks/:id', async (req, res) => {
    try {
      const task = await db.getOne('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const work_logs = await db.getMany(
        'SELECT * FROM work_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50', [task.id]
      );
      const comments = await db.getMany(
        'SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC', [task.id]
      );
      const dependencies = await db.getMany(
        `SELECT td.*, t.title, t.status FROM task_dependencies td
         JOIN tasks t ON t.id = td.depends_on_task_id WHERE td.task_id = $1`, [task.id]
      );
      res.json({ task, work_logs, comments, dependencies });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Update task
  r.put('/tasks/:id', async (req, res) => {
    try {
      const b = req.body;
      const fields = {};
      ['title', 'description', 'priority', 'category', 'deadline',
       'estimated_minutes', 'after_hours_auth', 'assigned_to_agent'
      ].forEach(k => { if (b[k] !== undefined) fields[k] = b[k]; });
      if (b.tags) fields.tags = `{${b.tags.join(',')}}`;
      if (b.metadata) fields.metadata = JSON.stringify(b.metadata);
      if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields to update' });

      // If assigned_to_agent is changing, log it and reset status to todo for dispatch
      let oldTask = null;
      if (fields.assigned_to_agent !== undefined) {
        oldTask = await db.getOne('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
        if (oldTask && fields.assigned_to_agent !== oldTask.assigned_to_agent) {
          fields.assigned_at = new Date().toISOString();
          if (oldTask.status === 'in_progress' || oldTask.status === 'blocked' || oldTask.status === 'unblocked') {
            fields.status = 'todo';
          }
        }
      }

      const rows = await db.update('tasks', fields, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });

      // Log the assignment change
      if (oldTask && fields.assigned_to_agent !== oldTask.assigned_to_agent) {
        await db.insert('work_logs', {
          task_id: parseInt(req.params.id), agent_id: 'human', action: 'assignment',
          notes: `Reassigned from ${oldTask.assigned_to_agent || 'unassigned'} to ${fields.assigned_to_agent || 'unassigned'} via Web UI`,
        });
        if (fields.status === 'todo' && oldTask.status !== 'todo') {
          await db.insert('work_logs', {
            task_id: parseInt(req.params.id), agent_id: 'human', action: 'status_change',
            status_from: oldTask.status, status_to: 'todo',
            notes: 'Reset to todo for dispatch to new agent',
          });
        }
      }

      if (eventBus) eventBus.emit('task', { action: 'updated', id: rows[0].id });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Delete (cancel) task
  r.delete('/tasks/:id', async (req, res) => {
    try {
      const rows = await db.update('tasks', { status: 'cancelled' }, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });
      await db.insert('work_logs', {
        task_id: parseInt(req.params.id), agent_id: 'human',
        action: 'status_change', status_from: rows[0].status, status_to: 'cancelled',
        notes: 'Cancelled via Web UI',
      });
      if (eventBus) eventBus.emit('task', { action: 'cancelled', id: parseInt(req.params.id) });
      res.json({ cancelled: true, task: rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Change status
  r.patch('/tasks/:id/status', async (req, res) => {
    try {
      const { status, note } = req.body;
      if (!status) return res.status(400).json({ error: 'status required' });
      const task = await db.getOne('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Mandatory notes for block/unblock
      if (status === 'blocked' && (!note || !note.trim())) {
        return res.status(400).json({ error: 'A note is required when blocking a task. Explain what you need, from whom, and what you tried.' });
      }
      if (task.status === 'blocked' && status !== 'blocked' && (!note || !note.trim())) {
        return res.status(400).json({ error: 'A note is required when unblocking a task. Explain how the blocker was resolved.' });
      }

      // Force blocked → unblocked transition (unless done/cancelled)
      let finalStatus = status;
      if (task.status === 'blocked' && status !== 'blocked' && status !== 'done' && status !== 'cancelled') {
        finalStatus = 'unblocked';
      }

      const updateData = { status: finalStatus };
      // Reset dispatch tracking on unblock so agent gets re-notified
      if (finalStatus === 'unblocked') {
        const meta = task.metadata || {};
        delete meta.dispatched_at;
        delete meta.dispatch_count;
        updateData.metadata = JSON.stringify(meta);
      }

      const rows = await db.update('tasks', updateData, 'id = $1', [req.params.id]);
      await db.insert('work_logs', {
        task_id: task.id, agent_id: 'human', action: 'status_change',
        status_from: task.status, status_to: finalStatus, notes: note || 'Status changed via Web UI',
      });
      if (eventBus) eventBus.emit('task', { action: 'status_changed', id: task.id });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Assign task
  r.patch('/tasks/:id/assign', async (req, res) => {
    try {
      const { agent_id, note } = req.body;
      if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
      const rows = await db.update('tasks', {
        assigned_to_agent: agent_id, assigned_at: new Date().toISOString(),
      }, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });
      await db.insert('work_logs', {
        task_id: parseInt(req.params.id), agent_id: 'human', action: 'assignment',
        notes: `Assigned to ${agent_id}${note ? ': ' + note : ''} via Web UI`,
      });
      if (eventBus) eventBus.emit('task', { action: 'assigned', id: parseInt(req.params.id) });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Task dependencies
  r.get('/tasks/:id/deps', async (req, res) => {
    try {
      const deps = await db.getMany(
        `SELECT td.*, t.title, t.status FROM task_dependencies td
         JOIN tasks t ON t.id = td.depends_on_task_id WHERE td.task_id = $1`, [req.params.id]
      );
      const dependents = await db.getMany(
        `SELECT td.*, t.title, t.status FROM task_dependencies td
         JOIN tasks t ON t.id = td.task_id WHERE td.depends_on_task_id = $1`, [req.params.id]
      );
      res.json({ depends_on: deps, depended_by: dependents });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/tasks/:id/deps', async (req, res) => {
    try {
      const { depends_on_task_id, dependency_type = 'blocks' } = req.body;
      if (!depends_on_task_id) return res.status(400).json({ error: 'depends_on_task_id required' });
      const dep = await db.insert('task_dependencies', {
        task_id: parseInt(req.params.id), depends_on_task_id, dependency_type,
      });
      if (eventBus) eventBus.emit('task', { action: 'dep_added', id: parseInt(req.params.id) });
      res.status(201).json(dep);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.delete('/tasks/:id/deps/:depId', async (req, res) => {
    try {
      const count = await db.delete('task_dependencies',
        'task_id = $1 AND depends_on_task_id = $2', [req.params.id, req.params.depId]);
      if (eventBus) eventBus.emit('task', { action: 'dep_removed', id: parseInt(req.params.id) });
      res.json({ removed: count });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

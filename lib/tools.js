'use strict';

// ── Result helpers ───────────────────────────────────────────────────────────
const ok  = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const err = (msg)  => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

/** Wrap an async handler with standard error handling. */
function wrap(fn) {
  return async function (_id, params) {
    try {
      return await fn(params || {});
    } catch (e) {
      return err(e.message || String(e));
    }
  };
}

/**
 * Build all task system tool definitions.
 * @param {import('./db').Database} db
 * @param {object} runtime - OpenClaw runtime
 * @param {object} [logger]
 * @param {object} [eventBus] - SSE event bus
 * @returns {Array<object>} Tool definitions
 */
/**
 * Check if `superior` is above `subordinate` in the agent hierarchy.
 * Walks the subordinate's reports_to chain up to max 10 levels.
 */
async function isAboveInHierarchy(db, superior, subordinate) {
  let current = subordinate;
  for (let depth = 0; depth < 10; depth++) {
    const agent = await db.getOne(
      'SELECT reports_to FROM agent_availability WHERE agent_id = $1', [current]
    );
    if (!agent || !agent.reports_to) return false;
    if (agent.reports_to === superior) return true;
    if (agent.reports_to === 'human') return false;
    current = agent.reports_to;
  }
  return false;
}

function buildTools(db, runtime, logger, eventBus, cfg) {
  const log = logger || { info: () => {}, error: () => {} };
  const emit = (cat, detail) => { if (eventBus) eventBus.emit(cat, detail); };

  return [

    // ════════════════════════════════════════════════════════════════════════
    // TASK MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════

    {
      name: 'task_create',
      description: 'Create a new task. Returns the created task with its ID and UUID.',
      parameters: {
        type: 'object',
        required: ['title', 'created_by_agent'],
        properties: {
          title:              { type: 'string', description: 'Task title' },
          description:        { type: 'string', description: 'Detailed description' },
          status:             { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'unblocked'], description: 'Initial status (default: todo)' },
          priority:           { type: 'number', enum: [1, 2, 3, 4], description: '1=urgent, 2=high, 3=normal, 4=low (default: 3)' },
          category:           { type: 'string', description: 'Task category (free text, default: general)' },
          created_by_agent:   { type: 'string', description: 'Agent ID creating this task' },
          assigned_to_agent:  { type: 'string', description: 'Agent ID to assign to' },
          deadline:           { type: 'string', description: 'Deadline as ISO 8601 timestamp' },
          estimated_minutes:  { type: 'number', description: 'Estimated time in minutes' },
          external_ref_type:  { type: 'string', description: 'External reference type (e.g. dispatch_job, samsara_vehicle)' },
          external_ref_id:    { type: 'string', description: 'External reference ID' },
          after_hours_auth:   { type: 'boolean', description: 'Authorized for after-hours work' },
          parent_task_id:     { type: 'number', description: 'Parent task ID for sub-tasks' },
          tags:               { type: 'array', items: { type: 'string' }, description: 'Tags array' },
          metadata:           { type: 'object', description: 'Arbitrary metadata JSON' },
        },
      },
      execute: wrap(async (p) => {
        // Hierarchy enforcement: tasks can only be assigned down the chain
        if (p.assigned_to_agent && p.created_by_agent) {
          const isSelf = p.created_by_agent === p.assigned_to_agent;
          if (!isSelf) {
            const canAssignDown = await isAboveInHierarchy(db, p.created_by_agent, p.assigned_to_agent);
            if (!canAssignDown) {
              return err(`Agent "${p.created_by_agent}" cannot create tasks for "${p.assigned_to_agent}" — tasks can only be assigned down the hierarchy`);
            }
          }
        }

        const data = {
          title:             p.title,
          description:       p.description || null,
          status:            p.status || 'todo',
          priority:          p.priority || 3,
          category:          p.category || 'general',
          created_by_agent:  p.created_by_agent,
          assigned_to_agent: p.assigned_to_agent || null,
          assigned_at:       p.assigned_to_agent ? new Date().toISOString() : null,
          deadline:          p.deadline || null,
          estimated_minutes: p.estimated_minutes || null,
          external_ref_type: p.external_ref_type || null,
          external_ref_id:   p.external_ref_id || null,
          after_hours_auth:  p.after_hours_auth || false,
          parent_task_id:    p.parent_task_id || null,
          tags:              p.tags ? `{${p.tags.join(',')}}` : '{}',
          metadata:          p.metadata ? JSON.stringify(p.metadata) : '{}',
        };
        const task = await db.insert('tasks', data);

        // Log creation
        await db.insert('work_logs', {
          task_id:  task.id,
          agent_id: p.created_by_agent,
          action:   'status_change',
          status_to: task.status,
          notes:    'Task created',
        });

        log.info(`[task-system] task #${task.id} created by ${p.created_by_agent}`);
        emit('task', { action: 'created', id: task.id });
        return ok(task);
      }),
    },

    {
      name: 'task_update',
      description: 'Update task fields (title, description, priority, category, deadline, tags, metadata, estimated_minutes).',
      parameters: {
        type: 'object',
        required: ['task_id', 'agent_id'],
        properties: {
          task_id:            { type: 'number', description: 'Task ID to update' },
          agent_id:           { type: 'string', description: 'Agent making the update' },
          title:              { type: 'string' },
          description:        { type: 'string' },
          priority:           { type: 'number', enum: [1, 2, 3, 4] },
          category:           { type: 'string' },
          deadline:           { type: 'string', description: 'ISO 8601 timestamp' },
          estimated_minutes:  { type: 'number' },
          after_hours_auth:   { type: 'boolean' },
          tags:               { type: 'array', items: { type: 'string' } },
          metadata:           { type: 'object' },
        },
      },
      execute: wrap(async (p) => {
        const fields = {};
        if (p.title !== undefined)            fields.title = p.title;
        if (p.description !== undefined)      fields.description = p.description;
        if (p.category !== undefined)         fields.category = p.category;
        if (p.deadline !== undefined)         fields.deadline = p.deadline;
        if (p.estimated_minutes !== undefined) fields.estimated_minutes = p.estimated_minutes;
        if (p.after_hours_auth !== undefined) fields.after_hours_auth = p.after_hours_auth;
        if (p.tags !== undefined)             fields.tags = `{${p.tags.join(',')}}`;
        if (p.metadata !== undefined)         fields.metadata = JSON.stringify(p.metadata);

        // Priority change gets its own work log
        if (p.priority !== undefined) {
          const before = await db.getOne('SELECT priority FROM tasks WHERE id = $1', [p.task_id]);
          fields.priority = p.priority;
          if (before && before.priority !== p.priority) {
            await db.insert('work_logs', {
              task_id: p.task_id, agent_id: p.agent_id,
              action: 'priority_change',
              notes: `Priority changed from ${before.priority} to ${p.priority}`,
            });
          }
        }

        if (Object.keys(fields).length === 0) return err('No fields to update');

        const rows = await db.update('tasks', fields, 'id = $1', [p.task_id]);
        if (rows.length === 0) return err(`Task #${p.task_id} not found`);
        emit('task', { action: 'updated', id: p.task_id });
        return ok(rows[0]);
      }),
    },

    {
      name: 'task_status',
      description: 'Change task status. WORKFLOW: (1) Set "in_progress" IMMEDIATELY when starting. (2) Set "blocked" if you need info — NEVER ask questions in chat, use blocked status instead. (3) Set "done" when complete with a summary. Requires a note. Auto-logs time from in_progress.',
      parameters: {
        type: 'object',
        required: ['task_id', 'agent_id', 'status', 'note'],
        properties: {
          task_id:  { type: 'number', description: 'Task ID' },
          agent_id: { type: 'string', description: 'Agent making the change' },
          status:   { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'unblocked', 'done', 'cancelled'], description: 'New status. Use in_progress when starting work, blocked when you need info (never ask in chat), done when complete. Unblocked tasks transition from blocked — set in_progress to resume work.' },
          note:     { type: 'string', description: 'REQUIRED. For in_progress: your plan. For blocked: what you need, from whom, what you tried. For done: what was completed and how to verify.' },
          time_spent_minutes: { type: 'number', description: 'Time spent on this task (optional, auto-calculated if omitted)' },
        },
      },
      execute: wrap(async (p) => {
        const task = await db.getOne('SELECT * FROM tasks WHERE id = $1', [p.task_id]);
        if (!task) return err(`Task #${p.task_id} not found`);

        // Mandatory meaningful note for blocked and unblock transitions
        if (p.status === 'blocked' && (!p.note || !p.note.trim())) {
          return err('A detailed reason is REQUIRED when setting status to blocked. Explain what you need, from whom, and what you already tried.');
        }
        if (task.status === 'blocked' && p.status !== 'blocked' && (!p.note || !p.note.trim())) {
          return err('A note is REQUIRED when unblocking a task. Explain how the blocker was resolved.');
        }

        // Force blocked → unblocked transition (unless going to done/cancelled)
        // This ensures the dispatcher notifies the assigned agent immediately
        if (task.status === 'blocked' && p.status !== 'blocked' && p.status !== 'done' && p.status !== 'cancelled') {
          p.status = 'unblocked';
        }

        const updateData = { status: p.status };

        // If moving to done, calculate actual_minutes from work logs
        if (p.status === 'done') {
          const timeResult = await db.getOne(
            'SELECT COALESCE(SUM(time_spent_minutes), 0) AS total FROM work_logs WHERE task_id = $1',
            [p.task_id]
          );
          updateData.actual_minutes = (parseInt(timeResult.total, 10) || 0) + (p.time_spent_minutes || 0);
        }

        // If unblocking, reset dispatch tracking and escalation state so fresh cycle starts
        if (task.status === 'blocked' && p.status === 'unblocked') {
          const meta = task.metadata || {};
          delete meta.dispatched_at;
          delete meta.dispatch_count;
          updateData.metadata = JSON.stringify(meta);
          updateData.escalation_level = 0;

          // Expire old escalation records for this task so max_escalations counter resets
          // on the next block cycle (previous block/unblock cycles shouldn't count)
          await db.query(
            `UPDATE escalation_history SET status = 'expired'
             WHERE task_id = $1 AND status = 'pending'`,
            [p.task_id]
          );
        }

        const rows = await db.update('tasks', updateData, 'id = $1', [p.task_id]);

        await db.insert('work_logs', {
          task_id: p.task_id,
          agent_id: p.agent_id,
          action: 'status_change',
          status_from: task.status,
          status_to: p.status,
          notes: p.note,
          time_spent_minutes: p.time_spent_minutes || 0,
        });

        log.info(`[task-system] task #${p.task_id} ${task.status} → ${p.status} by ${p.agent_id}`);
        emit('task', { action: 'status_changed', id: p.task_id });

        // Immediate escalation when task is blocked
        if (p.status === 'blocked') {
          try {
            const { EscalationEngine } = require('./escalation-engine');
            const engine = new EscalationEngine(db, log, runtime, eventBus, cfg);
            await engine.immediateBlockedEscalation(p.task_id, p.agent_id, p.note);
          } catch (escErr) {
            log.error(`[task-system] immediate blocked escalation failed: ${escErr.message}`);
          }
        }

        return ok(rows[0]);
      }),
    },

    {
      name: 'task_assign',
      description: 'Assign or reassign a task to an agent.',
      parameters: {
        type: 'object',
        required: ['task_id', 'agent_id', 'assigned_to_agent'],
        properties: {
          task_id:           { type: 'number', description: 'Task ID' },
          agent_id:          { type: 'string', description: 'Agent making the assignment' },
          assigned_to_agent: { type: 'string', description: 'Agent ID to assign to' },
          note:              { type: 'string', description: 'Reason for assignment' },
        },
      },
      execute: wrap(async (p) => {
        const task = await db.getOne('SELECT * FROM tasks WHERE id = $1', [p.task_id]);
        if (!task) return err(`Task #${p.task_id} not found`);

        // Hierarchy enforcement: can only assign to agents below in hierarchy
        const isSelf = p.agent_id === p.assigned_to_agent;
        if (!isSelf) {
          const canAssignDown = await isAboveInHierarchy(db, p.agent_id, p.assigned_to_agent);
          if (!canAssignDown) {
            return err(`Agent "${p.agent_id}" cannot assign tasks to "${p.assigned_to_agent}" — tasks can only be assigned down the hierarchy`);
          }
        }

        const isReassignment = task.assigned_to_agent && task.assigned_to_agent !== p.assigned_to_agent;
        const fields = {
          assigned_to_agent: p.assigned_to_agent,
          assigned_at: new Date().toISOString(),
        };

        // Reset status to todo on reassignment so dispatcher picks it up for the new agent
        if (isReassignment && (task.status === 'in_progress' || task.status === 'blocked' || task.status === 'unblocked')) {
          fields.status = 'todo';
        }

        const rows = await db.update('tasks', fields, 'id = $1', [p.task_id]);

        await db.insert('work_logs', {
          task_id: p.task_id,
          agent_id: p.agent_id,
          action: 'assignment',
          notes: `${isReassignment ? 'Reassigned' : 'Assigned'} to ${p.assigned_to_agent} from ${task.assigned_to_agent || 'unassigned'}${p.note ? ': ' + p.note : ''}`,
        });

        if (isReassignment && fields.status === 'todo') {
          await db.insert('work_logs', {
            task_id: p.task_id,
            agent_id: p.agent_id,
            action: 'status_change',
            status_from: task.status,
            status_to: 'todo',
            notes: 'Reset to todo for dispatch to new agent',
          });
        }

        log.info(`[task-system] task #${p.task_id} assigned to ${p.assigned_to_agent} by ${p.agent_id}`);
        emit('task', { action: 'assigned', id: p.task_id });
        return ok(rows[0]);
      }),
    },

    {
      name: 'task_query',
      description: 'Query tasks. Actions: list (filtered), get (by ID or UUID), my_tasks (assigned to calling agent), search (full-text).',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action:   { type: 'string', enum: ['list', 'get', 'my_tasks', 'search'], description: 'Query action' },
          id:       { type: 'number', description: 'Task ID (for get)' },
          uuid:     { type: 'string', description: 'Task UUID (for get)' },
          agent_id: { type: 'string', description: 'Agent ID (for my_tasks)' },
          status:   { type: 'string', description: 'Filter by status' },
          priority: { type: 'number', description: 'Filter by priority' },
          category: { type: 'string', description: 'Filter by category' },
          assigned_to: { type: 'string', description: 'Filter by assigned agent' },
          query:    { type: 'string', description: 'Search text (for search action)' },
          limit:    { type: 'number', description: 'Max results (default: 50)' },
          offset:   { type: 'number', description: 'Offset for pagination' },
        },
      },
      execute: wrap(async (p) => {
        const limit = Math.min(p.limit || 50, 200);
        const offset = p.offset || 0;

        switch (p.action) {
          case 'get': {
            let task;
            if (p.id) {
              task = await db.getOne('SELECT * FROM tasks WHERE id = $1', [p.id]);
            } else if (p.uuid) {
              task = await db.getOne('SELECT * FROM tasks WHERE uuid = $1', [p.uuid]);
            } else {
              return err('Provide id or uuid');
            }
            if (!task) return err('Task not found');
            // Include recent work logs
            const logs = await db.getMany(
              'SELECT * FROM work_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 20',
              [task.id]
            );
            return ok({ task, work_logs: logs });
          }

          case 'my_tasks': {
            if (!p.agent_id) return err('agent_id required for my_tasks');
            const tasks = await db.getMany(
              `SELECT * FROM tasks
               WHERE assigned_to_agent = $1 AND status IN ('todo', 'in_progress', 'blocked', 'unblocked')
               ORDER BY priority ASC, deadline ASC NULLS LAST
               LIMIT $2 OFFSET $3`,
              [p.agent_id, limit, offset]
            );
            return ok({ tasks, count: tasks.length });
          }

          case 'search': {
            if (!p.query) return err('query required for search');
            const tasks = await db.getMany(
              `SELECT * FROM tasks
               WHERE (title ILIKE $1 OR description ILIKE $1 OR category ILIKE $1)
               ORDER BY created_at DESC
               LIMIT $2 OFFSET $3`,
              [`%${p.query}%`, limit, offset]
            );
            return ok({ tasks, count: tasks.length });
          }

          default: { // list
            const conditions = [];
            const params = [];
            let idx = 1;

            if (p.status)      { conditions.push(`status = $${idx++}`); params.push(p.status); }
            if (p.priority)    { conditions.push(`priority = $${idx++}`); params.push(p.priority); }
            if (p.category)    { conditions.push(`category = $${idx++}`); params.push(p.category); }
            if (p.assigned_to) { conditions.push(`assigned_to_agent = $${idx++}`); params.push(p.assigned_to); }

            const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
            params.push(limit, offset);

            const tasks = await db.getMany(
              `SELECT * FROM tasks ${where}
               ORDER BY priority ASC, deadline ASC NULLS LAST, created_at DESC
               LIMIT $${idx++} OFFSET $${idx++}`,
              params
            );
            const total = await db.getCount(
              `SELECT COUNT(*) AS count FROM tasks ${where}`,
              params.slice(0, -2)
            );
            return ok({ tasks, total, limit, offset });
          }
        }
      }),
    },

    {
      name: 'task_dependencies',
      description: 'Manage task dependencies. Actions: add, remove, list, check_blocked.',
      parameters: {
        type: 'object',
        required: ['action', 'task_id'],
        properties: {
          action:             { type: 'string', enum: ['add', 'remove', 'list', 'check_blocked'] },
          task_id:            { type: 'number', description: 'Task ID' },
          depends_on_task_id: { type: 'number', description: 'Dependency task ID (for add/remove)' },
          dependency_type:    { type: 'string', enum: ['blocks', 'follows', 'related'], description: 'Dependency type (default: blocks)' },
        },
      },
      execute: wrap(async (p) => {
        switch (p.action) {
          case 'add': {
            if (!p.depends_on_task_id) return err('depends_on_task_id required');
            const dep = await db.insert('task_dependencies', {
              task_id: p.task_id,
              depends_on_task_id: p.depends_on_task_id,
              dependency_type: p.dependency_type || 'blocks',
            });
            emit('task', { action: 'dep_added', id: p.task_id });
            return ok(dep);
          }
          case 'remove': {
            if (!p.depends_on_task_id) return err('depends_on_task_id required');
            const count = await db.delete('task_dependencies',
              'task_id = $1 AND depends_on_task_id = $2',
              [p.task_id, p.depends_on_task_id]
            );
            emit('task', { action: 'dep_removed', id: p.task_id });
            return ok({ removed: count });
          }
          case 'check_blocked': {
            const blocking = await db.getMany(
              `SELECT td.*, t.status, t.title
               FROM task_dependencies td
               JOIN tasks t ON t.id = td.depends_on_task_id
               WHERE td.task_id = $1 AND td.dependency_type = 'blocks'
                 AND t.status NOT IN ('done', 'cancelled')`,
              [p.task_id]
            );
            return ok({ is_blocked: blocking.length > 0, blocking_tasks: blocking });
          }
          default: { // list
            const deps = await db.getMany(
              `SELECT td.*, t.title, t.status
               FROM task_dependencies td
               JOIN tasks t ON t.id = td.depends_on_task_id
               WHERE td.task_id = $1
               ORDER BY td.dependency_type`,
              [p.task_id]
            );
            const dependents = await db.getMany(
              `SELECT td.*, t.title, t.status
               FROM task_dependencies td
               JOIN tasks t ON t.id = td.task_id
               WHERE td.depends_on_task_id = $1
               ORDER BY td.dependency_type`,
              [p.task_id]
            );
            return ok({ depends_on: deps, depended_by: dependents });
          }
        }
      }),
    },

    {
      name: 'task_comment',
      description: 'Add a comment to a task.',
      parameters: {
        type: 'object',
        required: ['task_id', 'author', 'content'],
        properties: {
          task_id:     { type: 'number', description: 'Task ID' },
          author:      { type: 'string', description: 'Author (agent ID or human name)' },
          author_type: { type: 'string', enum: ['human', 'agent', 'system'], description: 'Author type (default: agent)' },
          content:     { type: 'string', description: 'Comment text' },
          is_internal: { type: 'boolean', description: 'Internal comment not visible to agents (default: false)' },
        },
      },
      execute: wrap(async (p) => {
        const comment = await db.insert('task_comments', {
          task_id:     p.task_id,
          author:      p.author,
          author_type: p.author_type || 'agent',
          content:     p.content,
          is_internal: p.is_internal || false,
        });
        emit('comment', { action: 'created', id: comment.id });
        return ok(comment);
      }),
    },

    {
      name: 'task_summary',
      description: 'Get dashboard summary: counts by status, by priority, by agent, overdue tasks, time totals.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Start date for time range (ISO 8601)' },
          date_to:   { type: 'string', description: 'End date for time range (ISO 8601)' },
        },
      },
      execute: wrap(async (p) => {
        const byStatus = await db.getMany(
          'SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status'
        );
        const byPriority = await db.getMany(
          `SELECT priority, COUNT(*) AS count FROM tasks
           WHERE status NOT IN ('done', 'cancelled')
           GROUP BY priority ORDER BY priority`
        );
        const byAgent = await db.getMany(
          `SELECT assigned_to_agent, COUNT(*) AS count, status FROM tasks
           WHERE assigned_to_agent IS NOT NULL AND status NOT IN ('done', 'cancelled')
           GROUP BY assigned_to_agent, status
           ORDER BY assigned_to_agent`
        );
        const overdue = await db.getCount(
          `SELECT COUNT(*) AS count FROM tasks
           WHERE deadline < NOW() AND status IN ('todo', 'in_progress', 'blocked', 'unblocked')`
        );
        const unassigned = await db.getCount(
          `SELECT COUNT(*) AS count FROM tasks
           WHERE assigned_to_agent IS NULL AND status IN ('todo', 'in_progress', 'unblocked')`
        );

        return ok({ by_status: byStatus, by_priority: byPriority, by_agent: byAgent, overdue, unassigned });
      }),
    },

    // ════════════════════════════════════════════════════════════════════════
    // WORK LOGS
    // ════════════════════════════════════════════════════════════════════════

    {
      name: 'worklog_add',
      description: 'Add a work log entry for a task: note, time spent, or any action. Does NOT change task status — use task_status for status transitions.',
      parameters: {
        type: 'object',
        required: ['task_id', 'agent_id'],
        properties: {
          task_id:            { type: 'number', description: 'Task ID' },
          agent_id:           { type: 'string', description: 'Agent ID' },
          action:             { type: 'string', enum: ['note', 'time_log', 'status_change', 'assignment', 'escalation', 'priority_change', 'deadline_change'], description: 'Log action type (default: note)' },
          notes:              { type: 'string', description: 'Notes or description of work done' },
          time_spent_minutes: { type: 'number', description: 'Time spent in minutes' },
          metadata:           { type: 'object', description: 'Extra metadata' },
        },
      },
      execute: wrap(async (p) => {
        const entry = await db.insert('work_logs', {
          task_id:            p.task_id,
          agent_id:           p.agent_id,
          action:             p.action || 'note',
          notes:              p.notes || null,
          time_spent_minutes: p.time_spent_minutes || 0,
          metadata:           p.metadata ? JSON.stringify(p.metadata) : '{}',
        });

        // Update task actual_minutes
        if (p.time_spent_minutes && p.time_spent_minutes > 0) {
          await db.query(
            'UPDATE tasks SET actual_minutes = COALESCE(actual_minutes, 0) + $1 WHERE id = $2',
            [p.time_spent_minutes, p.task_id]
          );
        }

        emit('worklog', { action: 'created', id: entry.id });
        return ok(entry);
      }),
    },

    {
      name: 'worklog_query',
      description: 'Query work logs by task, agent, action, or date range.',
      parameters: {
        type: 'object',
        properties: {
          task_id:   { type: 'number', description: 'Filter by task ID' },
          agent_id:  { type: 'string', description: 'Filter by agent ID' },
          action:    { type: 'string', description: 'Filter by action type' },
          date_from: { type: 'string', description: 'Start date (ISO 8601)' },
          date_to:   { type: 'string', description: 'End date (ISO 8601)' },
          limit:     { type: 'number', description: 'Max results (default: 50)' },
          offset:    { type: 'number', description: 'Offset for pagination' },
        },
      },
      execute: wrap(async (p) => {
        const conditions = [];
        const params = [];
        let idx = 1;

        if (p.task_id)   { conditions.push(`wl.task_id = $${idx++}`); params.push(p.task_id); }
        if (p.agent_id)  { conditions.push(`wl.agent_id = $${idx++}`); params.push(p.agent_id); }
        if (p.action)    { conditions.push(`wl.action = $${idx++}`); params.push(p.action); }
        if (p.date_from) { conditions.push(`wl.created_at >= $${idx++}`); params.push(p.date_from); }
        if (p.date_to)   { conditions.push(`wl.created_at <= $${idx++}`); params.push(p.date_to); }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const limit = Math.min(p.limit || 50, 200);
        params.push(limit, p.offset || 0);

        const logs = await db.getMany(
          `SELECT wl.*, t.title AS task_title
           FROM work_logs wl
           LEFT JOIN tasks t ON t.id = wl.task_id
           ${where}
           ORDER BY wl.created_at DESC
           LIMIT $${idx++} OFFSET $${idx++}`,
          params
        );
        return ok({ work_logs: logs, count: logs.length });
      }),
    },

    {
      name: 'worklog_time_report',
      description: 'Get time tracking report: total time by agent, task, category, or date range.',
      parameters: {
        type: 'object',
        properties: {
          group_by:  { type: 'string', enum: ['agent', 'task', 'category', 'date'], description: 'Group results by (default: agent)' },
          agent_id:  { type: 'string', description: 'Filter by agent ID' },
          date_from: { type: 'string', description: 'Start date (ISO 8601)' },
          date_to:   { type: 'string', description: 'End date (ISO 8601)' },
        },
      },
      execute: wrap(async (p) => {
        const conditions = [];
        const params = [];
        let idx = 1;

        if (p.agent_id)  { conditions.push(`wl.agent_id = $${idx++}`); params.push(p.agent_id); }
        if (p.date_from) { conditions.push(`wl.created_at >= $${idx++}`); params.push(p.date_from); }
        if (p.date_to)   { conditions.push(`wl.created_at <= $${idx++}`); params.push(p.date_to); }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        let query;
        switch (p.group_by) {
          case 'task':
            query = `SELECT wl.task_id, t.title, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries
                     FROM work_logs wl LEFT JOIN tasks t ON t.id = wl.task_id
                     ${where} GROUP BY wl.task_id, t.title ORDER BY total_minutes DESC`;
            break;
          case 'category':
            query = `SELECT t.category, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries
                     FROM work_logs wl LEFT JOIN tasks t ON t.id = wl.task_id
                     ${where} GROUP BY t.category ORDER BY total_minutes DESC`;
            break;
          case 'date':
            query = `SELECT DATE(wl.created_at) AS date, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries
                     FROM work_logs wl
                     ${where} GROUP BY DATE(wl.created_at) ORDER BY date DESC`;
            break;
          default: // agent
            query = `SELECT wl.agent_id, SUM(wl.time_spent_minutes) AS total_minutes, COUNT(*) AS entries
                     FROM work_logs wl
                     ${where} GROUP BY wl.agent_id ORDER BY total_minutes DESC`;
            break;
        }

        const report = await db.getMany(query, params);
        return ok({ report, group_by: p.group_by || 'agent' });
      }),
    },

    // ════════════════════════════════════════════════════════════════════════
    // AGENT AVAILABILITY
    // ════════════════════════════════════════════════════════════════════════

    {
      name: 'agent_status_update',
      description: 'Update own status (available, busy, off_duty, observation, maintenance) and record heartbeat.',
      parameters: {
        type: 'object',
        required: ['agent_id', 'status'],
        properties: {
          agent_id:        { type: 'string', description: 'Agent ID' },
          status:          { type: 'string', enum: ['available', 'busy', 'off_duty', 'observation', 'maintenance'] },
          current_task_id: { type: 'number', description: 'Currently active task ID' },
        },
      },
      execute: wrap(async (p) => {
        // Upsert
        const existing = await db.getOne('SELECT * FROM agent_availability WHERE agent_id = $1', [p.agent_id]);
        if (existing) {
          const rows = await db.update('agent_availability', {
            current_status:  p.status,
            last_heartbeat:  new Date().toISOString(),
            current_task_id: p.current_task_id !== undefined ? p.current_task_id : existing.current_task_id,
          }, 'agent_id = $1', [p.agent_id]);
          emit('agent', { action: 'status_changed', id: p.agent_id });
          return ok(rows[0]);
        } else {
          const row = await db.insert('agent_availability', {
            agent_id:       p.agent_id,
            current_status: p.status,
            last_heartbeat: new Date().toISOString(),
            current_task_id: p.current_task_id || null,
          });
          emit('agent', { action: 'status_changed', id: p.agent_id });
          return ok(row);
        }
      }),
    },

    {
      name: 'agent_query',
      description: 'Query agent availability. Actions: list (all agents), get (single), who_is_available (currently available agents).',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action:   { type: 'string', enum: ['list', 'get', 'who_is_available'] },
          agent_id: { type: 'string', description: 'Agent ID (for get)' },
        },
      },
      execute: wrap(async (p) => {
        switch (p.action) {
          case 'get': {
            if (!p.agent_id) return err('agent_id required');
            const agent = await db.getOne('SELECT * FROM agent_availability WHERE agent_id = $1', [p.agent_id]);
            if (!agent) return err(`Agent ${p.agent_id} not registered`);
            const tasks = await db.getMany(
              `SELECT id, title, status, priority FROM tasks
               WHERE assigned_to_agent = $1 AND status IN ('todo', 'in_progress', 'blocked', 'unblocked')
               ORDER BY priority ASC`,
              [p.agent_id]
            );
            return ok({ agent, active_tasks: tasks });
          }
          case 'who_is_available': {
            const agents = await db.getMany(
              `SELECT * FROM agent_availability WHERE current_status = 'available' ORDER BY agent_id`
            );
            return ok({ available_agents: agents });
          }
          default: { // list
            const agents = await db.getMany('SELECT * FROM agent_availability ORDER BY agent_id');
            return ok({ agents });
          }
        }
      }),
    },

    {
      name: 'agent_availability_set',
      description: 'Configure working hours, timezone, and capabilities for an agent (admin).',
      parameters: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id:            { type: 'string', description: 'Agent ID' },
          display_name:        { type: 'string' },
          working_hours_start: { type: 'string', description: 'Start time HH:MM (e.g. 08:00)' },
          working_hours_end:   { type: 'string', description: 'End time HH:MM (e.g. 17:00)' },
          working_days:        { type: 'array', items: { type: 'number' }, description: 'Working days (0=Sun..6=Sat)' },
          timezone:            { type: 'string', description: 'IANA timezone (e.g. America/Toronto)' },
          after_hours_capable: { type: 'boolean' },
          max_concurrent_tasks: { type: 'number' },
          capabilities:        { type: 'array', items: { type: 'string' }, description: 'Agent capabilities array' },
        },
      },
      execute: wrap(async (p) => {
        const existing = await db.getOne('SELECT * FROM agent_availability WHERE agent_id = $1', [p.agent_id]);
        const fields = {};
        if (p.display_name !== undefined)        fields.display_name = p.display_name;
        if (p.working_hours_start !== undefined)  fields.working_hours_start = p.working_hours_start;
        if (p.working_hours_end !== undefined)    fields.working_hours_end = p.working_hours_end;
        if (p.working_days !== undefined)         fields.working_days = `{${p.working_days.join(',')}}`;
        if (p.timezone !== undefined)             fields.timezone = p.timezone;
        if (p.after_hours_capable !== undefined)  fields.after_hours_capable = p.after_hours_capable;
        if (p.max_concurrent_tasks !== undefined) fields.max_concurrent_tasks = p.max_concurrent_tasks;
        if (p.capabilities !== undefined)         fields.capabilities = `{${p.capabilities.join(',')}}`;

        if (existing) {
          const rows = await db.update('agent_availability', fields, 'agent_id = $1', [p.agent_id]);
          emit('agent', { action: 'updated', id: p.agent_id });
          return ok(rows[0]);
        } else {
          fields.agent_id = p.agent_id;
          const row = await db.insert('agent_availability', fields);
          emit('agent', { action: 'created', id: p.agent_id });
          return ok(row);
        }
      }),
    },

    {
      name: 'agent_heartbeat',
      description: 'Record agent heartbeat. Call this periodically to indicate the agent is alive.',
      parameters: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID' },
        },
      },
      execute: wrap(async (p) => {
        const existing = await db.getOne('SELECT * FROM agent_availability WHERE agent_id = $1', [p.agent_id]);
        if (existing) {
          await db.update('agent_availability', { last_heartbeat: new Date().toISOString() }, 'agent_id = $1', [p.agent_id]);
        } else {
          await db.insert('agent_availability', { agent_id: p.agent_id, last_heartbeat: new Date().toISOString() });
        }
        return ok({ agent_id: p.agent_id, heartbeat: new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }) });
      }),
    },

    // ════════════════════════════════════════════════════════════════════════
    // ESCALATION
    // ════════════════════════════════════════════════════════════════════════

    {
      name: 'escalation_trigger',
      description: 'Manually trigger an escalation for a task.',
      parameters: {
        type: 'object',
        required: ['task_id', 'from_agent', 'to_agent', 'reason'],
        properties: {
          task_id:    { type: 'number', description: 'Task ID' },
          from_agent: { type: 'string', description: 'Agent triggering escalation' },
          to_agent:   { type: 'string', description: 'Target agent (or "human")' },
          reason:     { type: 'string', description: 'Reason for escalation' },
        },
      },
      execute: wrap(async (p) => {
        const esc = await db.insert('escalation_history', {
          task_id:           p.task_id,
          from_agent:        p.from_agent,
          to_agent:          p.to_agent,
          trigger_condition: 'permission_required',
          message_sent:      p.reason,
        });

        await db.update('tasks', { escalation_level: p.to_agent === 'human' ? 3 : 1 }, 'id = $1', [p.task_id]);

        await db.insert('work_logs', {
          task_id:  p.task_id,
          agent_id: p.from_agent,
          action:   'escalation',
          notes:    `Escalated to ${p.to_agent}: ${p.reason}`,
        });

        log.info(`[task-system] task #${p.task_id} escalated to ${p.to_agent} by ${p.from_agent}`);
        emit('escalation', { action: 'triggered', id: esc.id });

        // Wake the target agent (unless escalating to human)
        if (p.to_agent !== 'human' && runtime?.system?.runCommandWithTimeout) {
          const task = await db.getOne('SELECT * FROM tasks WHERE id = $1', [p.task_id]);
          const wakeMsg = `ESCALATION from ${p.from_agent}: ${p.reason} (Task #${p.task_id}: ${task?.title || 'unknown'})`;
          try {
            await runtime.system.runCommandWithTimeout(
              ['openclaw', 'agent', '--agent', p.to_agent, '--message', wakeMsg, '--timeout', '120'],
              { timeoutMs: 130000 }
            );
            log.info(`[task-system] woke agent ${p.to_agent} for escalation on task #${p.task_id}`);
          } catch (e) {
            log.error(`[task-system] failed to wake agent ${p.to_agent}: ${e.message}`);
          }
        }

        return ok(esc);
      }),
    },

    {
      name: 'escalation_respond',
      description: 'Respond to an escalation: acknowledge, resolve, or take_over.',
      parameters: {
        type: 'object',
        required: ['escalation_id', 'agent_id', 'response'],
        properties: {
          escalation_id: { type: 'number', description: 'Escalation history ID' },
          agent_id:      { type: 'string', description: 'Agent responding' },
          response:      { type: 'string', enum: ['acknowledge', 'resolve', 'take_over'], description: 'Response action' },
          message:       { type: 'string', description: 'Response message' },
        },
      },
      execute: wrap(async (p) => {
        const esc = await db.getOne('SELECT * FROM escalation_history WHERE id = $1', [p.escalation_id]);
        if (!esc) return err(`Escalation #${p.escalation_id} not found`);

        const statusMap = { acknowledge: 'acknowledged', resolve: 'resolved', take_over: 'resolved' };
        const rows = await db.update('escalation_history', {
          status:            statusMap[p.response],
          response_received: p.message || p.response,
          response_at:       new Date().toISOString(),
        }, 'id = $1', [p.escalation_id]);

        // If take_over, reassign the task and reset status to todo
        if (p.response === 'take_over') {
          await db.update('tasks', {
            assigned_to_agent: p.agent_id,
            assigned_at: new Date().toISOString(),
            status: 'todo',
          }, 'id = $1', [esc.task_id]);
          await db.insert('work_logs', {
            task_id: esc.task_id,
            agent_id: p.agent_id,
            action: 'assignment',
            notes: `Took over task via escalation #${p.escalation_id}`,
          });
        }

        emit('escalation', { action: p.response, id: p.escalation_id });
        return ok(rows[0]);
      }),
    },

    {
      name: 'escalation_query',
      description: 'Query escalation history. Filter by task, status, agent.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'Filter by task ID' },
          status:  { type: 'string', enum: ['pending', 'acknowledged', 'resolved', 'expired'], description: 'Filter by status' },
          limit:   { type: 'number', description: 'Max results (default: 50)' },
        },
      },
      execute: wrap(async (p) => {
        const conditions = [];
        const params = [];
        let idx = 1;

        if (p.task_id) { conditions.push(`eh.task_id = $${idx++}`); params.push(p.task_id); }
        if (p.status)  { conditions.push(`eh.status = $${idx++}`); params.push(p.status); }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const limit = Math.min(p.limit || 50, 200);
        params.push(limit);

        const history = await db.getMany(
          `SELECT eh.*, t.title AS task_title, er.name AS rule_name
           FROM escalation_history eh
           LEFT JOIN tasks t ON t.id = eh.task_id
           LEFT JOIN escalation_rules er ON er.id = eh.rule_id
           ${where}
           ORDER BY eh.created_at DESC
           LIMIT $${idx}`,
          params
        );
        return ok({ escalations: history, count: history.length });
      }),
    },

    {
      name: 'escalation_rules_manage',
      description: 'Manage escalation rules. Actions: list, get, create, update, delete.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action:            { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
          id:                { type: 'number', description: 'Rule ID (for get/update/delete)' },
          name:              { type: 'string' },
          trigger_condition: { type: 'string', enum: ['timeout', 'blocked', 'after_hours', 'priority_urgent', 'permission_required', 'deadline_approaching', 'deadline_missed'] },
          task_category:     { type: 'string' },
          from_agent:        { type: 'string' },
          to_agent:          { type: 'string' },
          timeout_minutes:   { type: 'number' },
          sms_template:      { type: 'string' },
          enabled:           { type: 'boolean' },
          cooldown_minutes:  { type: 'number' },
          max_escalations:   { type: 'number' },
        },
      },
      execute: wrap(async (p) => {
        switch (p.action) {
          case 'get': {
            if (!p.id) return err('id required');
            const rule = await db.getOne('SELECT * FROM escalation_rules WHERE id = $1', [p.id]);
            return rule ? ok(rule) : err('Rule not found');
          }
          case 'create': {
            if (!p.name || !p.trigger_condition || !p.to_agent) return err('name, trigger_condition, and to_agent required');
            const rule = await db.insert('escalation_rules', {
              name: p.name, trigger_condition: p.trigger_condition,
              task_category: p.task_category || null, from_agent: p.from_agent || null,
              to_agent: p.to_agent, timeout_minutes: p.timeout_minutes || null,
              sms_template: p.sms_template || null, enabled: p.enabled !== false,
              cooldown_minutes: p.cooldown_minutes || 30, max_escalations: p.max_escalations || 3,
            });
            emit('rule', { action: 'created', id: rule.id });
            return ok(rule);
          }
          case 'update': {
            if (!p.id) return err('id required');
            const fields = {};
            ['name', 'trigger_condition', 'task_category', 'from_agent', 'to_agent',
             'timeout_minutes', 'sms_template', 'enabled', 'cooldown_minutes', 'max_escalations'
            ].forEach(k => { if (p[k] !== undefined) fields[k] = p[k]; });
            if (Object.keys(fields).length === 0) return err('No fields to update');
            const rows = await db.update('escalation_rules', fields, 'id = $1', [p.id]);
            if (rows.length) emit('rule', { action: 'updated', id: p.id });
            return rows.length ? ok(rows[0]) : err('Rule not found');
          }
          case 'delete': {
            if (!p.id) return err('id required');
            const count = await db.delete('escalation_rules', 'id = $1', [p.id]);
            emit('rule', { action: 'deleted', id: p.id });
            return ok({ deleted: count });
          }
          default: { // list
            const rules = await db.getMany('SELECT * FROM escalation_rules ORDER BY id');
            return ok({ rules });
          }
        }
      }),
    },

    // ════════════════════════════════════════════════════════════════════════
    // WEBHOOK TOOLS
    // ════════════════════════════════════════════════════════════════════════

    {
      name: 'webhook_source_manage',
      description: 'Manage webhook sources. Actions: list, get, create, update, delete.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action:             { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
          id:                 { type: 'number', description: 'Source ID' },
          name:               { type: 'string', description: 'Source name' },
          slug:               { type: 'string', description: 'URL slug (unique, used in endpoint URL)' },
          description:        { type: 'string' },
          secret:             { type: 'string', description: 'HMAC-SHA256 signing secret' },
          enabled:            { type: 'boolean' },
          forward_url:        { type: 'string', description: 'URL to forward payload after processing' },
          headers_to_extract: { type: 'array', items: { type: 'string' }, description: 'Header names to capture as variables' },
        },
      },
      execute: wrap(async (p) => {
        switch (p.action) {
          case 'get': {
            if (!p.id) return err('id required');
            const src = await db.getOne('SELECT * FROM webhook_sources WHERE id = $1', [p.id]);
            return src ? ok(src) : err('Source not found');
          }
          case 'create': {
            if (!p.name || !p.slug) return err('name and slug required');
            const src = await db.insert('webhook_sources', {
              name: p.name, slug: p.slug, description: p.description || null,
              secret: p.secret || null, enabled: p.enabled !== false,
              forward_url: p.forward_url || null,
              headers_to_extract: p.headers_to_extract ? `{${p.headers_to_extract.join(',')}}` : '{}',
            });
            emit('webhook', { action: 'source_created', id: src.id });
            return ok(src);
          }
          case 'update': {
            if (!p.id) return err('id required');
            const fields = {};
            ['name', 'slug', 'description', 'secret', 'enabled', 'forward_url'].forEach(k => {
              if (p[k] !== undefined) fields[k] = p[k];
            });
            if (p.headers_to_extract !== undefined) fields.headers_to_extract = `{${p.headers_to_extract.join(',')}}`;
            if (Object.keys(fields).length === 0) return err('No fields to update');
            const rows = await db.update('webhook_sources', fields, 'id = $1', [p.id]);
            if (rows.length) emit('webhook', { action: 'source_updated', id: p.id });
            return rows.length ? ok(rows[0]) : err('Source not found');
          }
          case 'delete': {
            if (!p.id) return err('id required');
            const count = await db.delete('webhook_sources', 'id = $1', [p.id]);
            emit('webhook', { action: 'source_deleted', id: p.id });
            return ok({ deleted: count });
          }
          default: { // list
            const sources = await db.getMany('SELECT * FROM webhook_sources ORDER BY name');
            return ok({ sources });
          }
        }
      }),
    },

    {
      name: 'webhook_template_manage',
      description: 'Manage webhook templates (event→task mappings). Actions: list, get, create, update, delete.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action:                    { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
          id:                        { type: 'number' },
          source_id:                 { type: 'number', description: 'Webhook source ID' },
          name:                      { type: 'string' },
          enabled:                   { type: 'boolean' },
          match_rules:               { type: 'array', description: 'Array of {path, op, value} match conditions' },
          task_title_template:       { type: 'string' },
          task_description_template: { type: 'string' },
          task_priority_expr:        { type: 'string' },
          task_category:             { type: 'string' },
          assigned_to_agent:         { type: 'string' },
          deadline_offset_minutes:   { type: 'number' },
          external_ref_type:         { type: 'string' },
          external_ref_id_expr:      { type: 'string' },
          tags:                      { type: 'array', items: { type: 'string' } },
        },
      },
      execute: wrap(async (p) => {
        switch (p.action) {
          case 'get': {
            if (!p.id) return err('id required');
            const tmpl = await db.getOne('SELECT * FROM webhook_templates WHERE id = $1', [p.id]);
            return tmpl ? ok(tmpl) : err('Template not found');
          }
          case 'create': {
            if (!p.source_id || !p.name || !p.task_title_template) {
              return err('source_id, name, and task_title_template required');
            }
            const tmpl = await db.insert('webhook_templates', {
              source_id: p.source_id, name: p.name, enabled: p.enabled !== false,
              match_rules: JSON.stringify(p.match_rules || []),
              task_title_template: p.task_title_template,
              task_description_template: p.task_description_template || null,
              task_priority_expr: p.task_priority_expr || '3',
              task_category: p.task_category || 'general',
              assigned_to_agent: p.assigned_to_agent || null,
              deadline_offset_minutes: p.deadline_offset_minutes || null,
              external_ref_type: p.external_ref_type || null,
              external_ref_id_expr: p.external_ref_id_expr || null,
              tags: p.tags ? `{${p.tags.join(',')}}` : '{}',
            });
            emit('webhook', { action: 'template_created', id: tmpl.id });
            return ok(tmpl);
          }
          case 'update': {
            if (!p.id) return err('id required');
            const fields = {};
            ['source_id', 'name', 'enabled', 'task_title_template', 'task_description_template',
             'task_priority_expr', 'task_category', 'assigned_to_agent',
             'deadline_offset_minutes', 'external_ref_type', 'external_ref_id_expr'
            ].forEach(k => { if (p[k] !== undefined) fields[k] = p[k]; });
            if (p.match_rules !== undefined) fields.match_rules = JSON.stringify(p.match_rules);
            if (p.tags !== undefined) fields.tags = `{${p.tags.join(',')}}`;
            if (Object.keys(fields).length === 0) return err('No fields to update');
            const rows = await db.update('webhook_templates', fields, 'id = $1', [p.id]);
            if (rows.length) emit('webhook', { action: 'template_updated', id: p.id });
            return rows.length ? ok(rows[0]) : err('Template not found');
          }
          case 'delete': {
            if (!p.id) return err('id required');
            const count = await db.delete('webhook_templates', 'id = $1', [p.id]);
            emit('webhook', { action: 'template_deleted', id: p.id });
            return ok({ deleted: count });
          }
          default: { // list
            const filter = p.source_id
              ? { where: 'WHERE source_id = $1', params: [p.source_id] }
              : { where: '', params: [] };
            const templates = await db.getMany(
              `SELECT wt.*, ws.name AS source_name
               FROM webhook_templates wt
               LEFT JOIN webhook_sources ws ON ws.id = wt.source_id
               ${filter.where}
               ORDER BY wt.source_id, wt.name`,
              filter.params
            );
            return ok({ templates });
          }
        }
      }),
    },

    {
      name: 'webhook_query',
      description: 'Query webhook log. Filter by source, status, date range. Also lists unmatched events.',
      parameters: {
        type: 'object',
        properties: {
          source_id:         { type: 'number', description: 'Filter by source ID' },
          processing_status: { type: 'string', enum: ['received', 'matched', 'task_created', 'forwarded', 'unmatched', 'error'] },
          unmatched_only:    { type: 'boolean', description: 'Show only unmatched events' },
          date_from:         { type: 'string' },
          date_to:           { type: 'string' },
          limit:             { type: 'number', description: 'Max results (default: 50)' },
        },
      },
      execute: wrap(async (p) => {
        const conditions = [];
        const params = [];
        let idx = 1;

        if (p.source_id)         { conditions.push(`wl.source_id = $${idx++}`); params.push(p.source_id); }
        if (p.processing_status) { conditions.push(`wl.processing_status = $${idx++}`); params.push(p.processing_status); }
        if (p.unmatched_only)    { conditions.push(`wl.processing_status = 'unmatched'`); }
        if (p.date_from)         { conditions.push(`wl.created_at >= $${idx++}`); params.push(p.date_from); }
        if (p.date_to)           { conditions.push(`wl.created_at <= $${idx++}`); params.push(p.date_to); }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const limit = Math.min(p.limit || 50, 200);
        params.push(limit);

        const logs = await db.getMany(
          `SELECT wl.*, ws.name AS source_name
           FROM webhook_log wl
           LEFT JOIN webhook_sources ws ON ws.id = wl.source_id
           ${where}
           ORDER BY wl.created_at DESC
           LIMIT $${idx}`,
          params
        );
        return ok({ webhook_events: logs, count: logs.length });
      }),
    },

    {
      name: 'webhook_test',
      description: 'Test a webhook template against a sample payload (dry run). Shows what task would be created without actually creating it.',
      parameters: {
        type: 'object',
        required: ['template_id', 'payload'],
        properties: {
          template_id: { type: 'number', description: 'Template ID to test' },
          payload:     { type: 'object', description: 'Sample webhook payload JSON' },
        },
      },
      execute: wrap(async (p) => {
        const tmpl = await db.getOne('SELECT * FROM webhook_templates WHERE id = $1', [p.template_id]);
        if (!tmpl) return err('Template not found');

        // Lazy-require to avoid circular deps
        const { flattenPayload, evaluateMatchRules, renderTemplate } = require('./webhook-templates');

        const vars = flattenPayload(p.payload);
        const matched = evaluateMatchRules(tmpl.match_rules, vars);

        if (!matched) {
          return ok({ matched: false, reason: 'Match rules did not match', flattened_vars: vars });
        }

        const taskPreview = {
          title:       renderTemplate(tmpl.task_title_template, vars),
          description: renderTemplate(tmpl.task_description_template || '', vars),
          priority:    renderTemplate(tmpl.task_priority_expr || '3', vars),
          category:    tmpl.task_category,
          assigned_to: tmpl.assigned_to_agent,
          external_ref_type: tmpl.external_ref_type,
          external_ref_id:   tmpl.external_ref_id_expr ? renderTemplate(tmpl.external_ref_id_expr, vars) : null,
        };

        return ok({ matched: true, flattened_vars: vars, task_preview: taskPreview });
      }),
    },

    {
      name: 'webhook_replay',
      description: 'Replay a logged webhook event through the template engine to create a task.',
      parameters: {
        type: 'object',
        required: ['webhook_log_id'],
        properties: {
          webhook_log_id: { type: 'number', description: 'Webhook log entry ID to replay' },
        },
      },
      execute: wrap(async (p) => {
        const entry = await db.getOne('SELECT * FROM webhook_log WHERE id = $1', [p.webhook_log_id]);
        if (!entry) return err('Webhook log entry not found');

        const { processWebhookEvent } = require('./webhook-templates');
        const result = await processWebhookEvent(db, entry.source_id, entry.payload, entry.flattened_vars, log);

        return ok({ replayed: true, result });
      }),
    },

    // ════════════════════════════════════════════════════════════════════════
    // SCHEDULER
    // ════════════════════════════════════════════════════════════════════════

    {
      name: 'scheduler_check_stuck',
      description: 'Check for tasks stuck in_progress beyond the threshold and trigger escalation.',
      parameters: {
        type: 'object',
        properties: {
          threshold_minutes: { type: 'number', description: 'Override stuck threshold (default: from config)' },
        },
      },
      execute: wrap(async (p) => {
        const { EscalationEngine } = require('./escalation-engine');
        const engine = new EscalationEngine(db, log, runtime, eventBus, cfg);
        const result = await engine.checkStuckTasks(p.threshold_minutes);
        return ok(result);
      }),
    },

    {
      name: 'scheduler_check_deadlines',
      description: 'Check for approaching or missed deadlines and trigger warnings/escalations.',
      parameters: {
        type: 'object',
        properties: {
          warning_minutes: { type: 'number', description: 'Override warning window (default: from config)' },
        },
      },
      execute: wrap(async (p) => {
        const { EscalationEngine } = require('./escalation-engine');
        const engine = new EscalationEngine(db, log, runtime, eventBus, cfg);
        const result = await engine.checkDeadlines(p.warning_minutes);
        return ok(result);
      }),
    },

    {
      name: 'scheduler_run_cycle',
      description: 'Run a full scheduler cycle: stuck task detection, deadline checks, escalation processing, after-hours detection, urgent task monitoring, unblocked task notification, task dispatch with priority preemption and aging.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: wrap(async () => {
        const { EscalationEngine } = require('./escalation-engine');
        const engine = new EscalationEngine(db, log, runtime, eventBus, cfg);

        // Diagnostic: what does the DB actually contain right now?
        const diagnostics = {
          active_tasks: await db.getMany(
            `SELECT id, title, status, priority, assigned_to_agent, escalation_level,
                    updated_at, metadata->>'dispatched_at' AS dispatched_at,
                    metadata->>'dispatch_count' AS dispatch_count
             FROM tasks WHERE status IN ('todo', 'in_progress', 'blocked', 'unblocked')
             ORDER BY priority ASC, updated_at ASC`
          ),
          escalation_rules: await db.getMany(
            `SELECT id, name, trigger_condition, to_agent, timeout_minutes, cooldown_minutes, max_escalations, enabled FROM escalation_rules`
          ),
          pending_escalations: await db.getMany(
            `SELECT id, task_id, rule_id, from_agent, to_agent, trigger_condition, status, created_at FROM escalation_history WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10`
          ),
          recent_escalations: await db.getMany(
            `SELECT id, task_id, rule_id, from_agent, to_agent, trigger_condition, status, created_at FROM escalation_history ORDER BY created_at DESC LIMIT 10`
          ),
          agents: await db.getMany(
            `SELECT agent_id, reports_to, after_hours_capable, current_status, max_concurrent_tasks FROM agent_availability`
          ),
        };

        const stuck = await engine.checkStuckTasks();
        const deadlines = await engine.checkDeadlines();
        const escalations = await engine.processBlockedTasks();
        const afterHours = await engine.checkAfterHours();
        const urgent = await engine.checkUrgentTasks();
        const unacknowledged = await engine.checkUnacknowledgedDispatches();

        // Check for unblocked tasks awaiting dispatch
        const unblockedTasks = await db.getMany(
          `SELECT id, title, assigned_to_agent, priority FROM tasks WHERE status = 'unblocked' ORDER BY priority ASC`
        );

        const { TaskDispatcher } = require('./task-dispatcher');
        const dispatcher = new TaskDispatcher(db, runtime, log, eventBus, cfg?.scheduler);
        const dispatch = await dispatcher.dispatch();

        return ok({ diagnostics, stuck, deadlines, escalations, after_hours: afterHours, urgent, unacknowledged, unblocked_pending: unblockedTasks, dispatch, ran_at: new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }) });
      }),
    },

    {
      name: 'scheduler_status',
      description: 'Get scheduler status: configuration, last run time, next scheduled run.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: wrap(async () => {
        const openTasks = await db.getCount(
          `SELECT COUNT(*) AS count FROM tasks WHERE status IN ('todo', 'in_progress', 'blocked', 'unblocked')`
        );
        const pendingEscalations = await db.getCount(
          `SELECT COUNT(*) AS count FROM escalation_history WHERE status = 'pending'`
        );
        const overdueTasks = await db.getCount(
          `SELECT COUNT(*) AS count FROM tasks WHERE deadline < NOW() AND status IN ('todo', 'in_progress', 'blocked', 'unblocked')`
        );

        return ok({
          open_tasks: openTasks,
          pending_escalations: pendingEscalations,
          overdue_tasks: overdueTasks,
          checked_at: new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }),
        });
      }),
    },

    // ════════════════════════════════════════════════════════════════════════
    // SYSTEM
    // ════════════════════════════════════════════════════════════════════════

    {
      name: 'task_system_health',
      description: 'Health check: database connection, pool stats.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: wrap(async () => {
        const dbHealth = await db.ping();
        return ok({ database: dbHealth, timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }) });
      }),
    },

    {
      name: 'task_system_stats',
      description: 'System statistics: total tasks, completion rates, average resolution time, agent load.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look-back period in days (default: 7)' },
        },
      },
      execute: wrap(async (p) => {
        const days = p.days || 7;
        const since = new Date(Date.now() - days * 86400000).toISOString();

        const total = await db.getCount('SELECT COUNT(*) AS count FROM tasks');
        const completed = await db.getCount(
          `SELECT COUNT(*) AS count FROM tasks WHERE status = 'done' AND updated_at >= $1`,
          [since]
        );
        const created = await db.getCount(
          `SELECT COUNT(*) AS count FROM tasks WHERE created_at >= $1`,
          [since]
        );
        const avgResolution = await db.getOne(
          `SELECT AVG(actual_minutes) AS avg_minutes FROM tasks WHERE status = 'done' AND actual_minutes > 0 AND updated_at >= $1`,
          [since]
        );

        return ok({
          period_days: days,
          total_tasks: total,
          created_in_period: created,
          completed_in_period: completed,
          completion_rate: created > 0 ? (completed / created * 100).toFixed(1) + '%' : 'N/A',
          avg_resolution_minutes: avgResolution?.avg_minutes ? Math.round(parseFloat(avgResolution.avg_minutes)) : null,
        });
      }),
    },

    {
      name: 'task_system_cron_query',
      description: 'Query OpenClaw cron jobs. Lists all jobs or filters by agent.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Filter by agent ID' },
        },
      },
      execute: wrap(async (p) => {
        const fs = require('fs');
        const cronFile = (process.env.HOME || '/root') + '/.openclaw/cron/jobs.json';
        if (!fs.existsSync(cronFile)) return err('Cron jobs file not found');

        const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
        let jobs = data.jobs || [];

        if (p.agent_id) {
          jobs = jobs.filter(j => j.agentId === p.agent_id);
        }

        return ok({ jobs, total: jobs.length });
      }),
    },

    {
      name: 'task_system_cron_manage',
      description: 'Create, update, or delete OpenClaw cron jobs. Actions: create, update, delete, toggle.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action:         { type: 'string', enum: ['create', 'update', 'delete', 'toggle'] },
          id:             { type: 'string', description: 'Job ID (for update/delete/toggle)' },
          agentId:        { type: 'string', description: 'Target agent ID' },
          name:           { type: 'string', description: 'Job name' },
          enabled:        { type: 'boolean' },
          schedule:       { type: 'object', description: 'Schedule object: {kind, expr, tz} or {kind, everyMs}' },
          sessionTarget:  { type: 'string', enum: ['isolated', 'main'] },
          wakeMode:       { type: 'string', enum: ['now', 'scheduled'] },
          message:        { type: 'string', description: 'Agent instruction message' },
          timeoutSeconds: { type: 'number' },
        },
      },
      execute: wrap(async (p) => {
        const fs = require('fs');
        const crypto = require('crypto');
        const cronFile = (process.env.HOME || '/root') + '/.openclaw/cron/jobs.json';

        const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));

        switch (p.action) {
          case 'create': {
            if (!p.agentId || !p.name || !p.schedule || !p.message) {
              return err('agentId, name, schedule, and message required');
            }
            const job = {
              id: crypto.randomUUID(),
              agentId: p.agentId,
              name: p.name,
              enabled: p.enabled !== false,
              createdAtMs: Date.now(),
              updatedAtMs: Date.now(),
              schedule: p.schedule,
              sessionTarget: p.sessionTarget || 'isolated',
              wakeMode: p.wakeMode || 'now',
              payload: {
                kind: 'agentTurn',
                message: p.message,
                timeoutSeconds: p.timeoutSeconds || 120,
              },
              delivery: { mode: 'none' },
              state: {},
            };
            data.jobs.push(job);
            fs.writeFileSync(cronFile, JSON.stringify(data, null, 2));
            emit('cron', { action: 'created', id: job.id });
            return ok(job);
          }
          case 'update': {
            if (!p.id) return err('id required');
            const idx = data.jobs.findIndex(j => j.id === p.id);
            if (idx === -1) return err('Job not found');
            const job = data.jobs[idx];
            if (p.name)           job.name = p.name;
            if (p.agentId)        job.agentId = p.agentId;
            if (p.enabled !== undefined) job.enabled = p.enabled;
            if (p.schedule)       job.schedule = p.schedule;
            if (p.sessionTarget)  job.sessionTarget = p.sessionTarget;
            if (p.wakeMode)       job.wakeMode = p.wakeMode;
            if (p.message)        job.payload.message = p.message;
            if (p.timeoutSeconds) job.payload.timeoutSeconds = p.timeoutSeconds;
            job.updatedAtMs = Date.now();
            fs.writeFileSync(cronFile, JSON.stringify(data, null, 2));
            emit('cron', { action: 'updated', id: job.id });
            return ok(job);
          }
          case 'delete': {
            if (!p.id) return err('id required');
            const before = data.jobs.length;
            data.jobs = data.jobs.filter(j => j.id !== p.id);
            if (data.jobs.length === before) return err('Job not found');
            fs.writeFileSync(cronFile, JSON.stringify(data, null, 2));
            emit('cron', { action: 'deleted', id: p.id });
            return ok({ deleted: true });
          }
          case 'toggle': {
            if (!p.id) return err('id required');
            const job = data.jobs.find(j => j.id === p.id);
            if (!job) return err('Job not found');
            job.enabled = !job.enabled;
            job.updatedAtMs = Date.now();
            fs.writeFileSync(cronFile, JSON.stringify(data, null, 2));
            emit('cron', { action: 'toggled', id: job.id });
            return ok(job);
          }
          default:
            return err('Unknown action');
        }
      }),
    },

  ];
}

module.exports = { buildTools };

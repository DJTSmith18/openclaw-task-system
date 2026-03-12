'use strict';

const { isWithinWorkingHours, isTaskAllowedNow } = require('./time-utils');
const { PRIORITY_LABELS, buildTaskTranscript } = require('./message-formatter');

class TaskDispatcher {
  constructor(db, runtime, logger, eventBus, config, escalationConfig) {
    this.db = db;
    this.runtime = runtime;
    this.log = logger || { info: () => {}, error: () => {} };
    this.emit = (cat, detail) => { if (eventBus) eventBus.emit(cat, detail); };
    this.config = {
      dispatch_cooldown_minutes: config?.dispatch_cooldown_minutes || 15,
      priority_aging_minutes:    config?.priority_aging_minutes    || 60,
      preemption_enabled:        config?.preemption_enabled !== false,
      wake_timeout_seconds:      config?.wake_timeout_seconds      || 120,
      max_dispatch_attempts:     config?.max_dispatch_attempts     || 3,
    };
    this.escalationConfig = escalationConfig || {};
  }

  // ── Main Entry ──────────────────────────────────────────────────────────────

  async dispatch(opts = {}) {
    const { maxPriority } = opts;
    // Skip priority aging in urgent mode — urgent tasks are already priority=1
    const aging = maxPriority ? { aged_count: 0, tasks: [] } : await this.agePriorities();
    const completions = await this.notifyCompletedTasks(maxPriority);
    const dispatched = await this.dispatchAgents(maxPriority);
    return { aging, completions, dispatched };
  }

  // ── Priority Aging ──────────────────────────────────────────────────────────

  async agePriorities() {
    const threshold = this.config.priority_aging_minutes;
    const tasks = await this.db.getMany(
      `SELECT * FROM tasks
       WHERE status IN ('todo', 'unblocked')
         AND priority > 1
         AND updated_at < NOW() - INTERVAL '${threshold} minutes'
       ORDER BY priority DESC, created_at ASC`
    );

    const aged = [];
    for (const task of tasks) {
      const oldPriority = task.priority;
      const newPriority = oldPriority - 1;

      // Track original priority in metadata (only set on first aging)
      const meta = task.metadata || {};
      if (!meta.original_priority) meta.original_priority = oldPriority;
      meta.aged_at = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });

      await this.db.update('tasks', {
        priority: newPriority,
        metadata: JSON.stringify(meta),
      }, 'id = $1', [task.id]);

      await this.db.insert('work_logs', {
        task_id:  task.id,
        agent_id: 'system',
        action:   'priority_change',
        notes:    `Priority aged from ${PRIORITY_LABELS[oldPriority]} to ${PRIORITY_LABELS[newPriority]} (inactive for >${threshold} min)`,
      });

      this.emit('task', { action: 'priority_aged', id: task.id });
      this.log.info(`[task-system/dispatch] task #${task.id} priority aged: ${PRIORITY_LABELS[oldPriority]} → ${PRIORITY_LABELS[newPriority]}`);

      aged.push({
        task_id: task.id,
        title: task.title,
        old_priority: PRIORITY_LABELS[oldPriority],
        new_priority: PRIORITY_LABELS[newPriority],
      });
    }

    return { aged_count: aged.length, tasks: aged };
  }

  // ── Completion Notifications ────────────────────────────────────────────────

  async notifyCompletedTasks(maxPriority) {
    // Find tasks recently set to done/cancelled where:
    // 1. created_by_agent != assigned_to_agent (cross-agent task)
    // 2. Not yet notified (metadata.creator_notified is not set)
    const priorityFilter = maxPriority ? `AND priority <= ${parseInt(maxPriority, 10)}` : '';
    const tasks = await this.db.getMany(
      `SELECT * FROM tasks
       WHERE status IN ('done', 'cancelled')
         AND created_by_agent IS NOT NULL
         AND assigned_to_agent IS NOT NULL
         AND created_by_agent != assigned_to_agent
         AND (metadata->>'creator_notified') IS NULL
         ${priorityFilter}
       ORDER BY updated_at ASC`
    );

    if (tasks.length === 0) return { notified_count: 0, details: [] };

    // ── MARK ALL AS NOTIFIED FIRST to prevent duplicate notifications ──
    // Race condition: normal and urgent cycles can overlap. By marking before
    // sending, concurrent cycles won't pick up the same tasks.
    const now = new Date().toISOString();
    for (const t of tasks) {
      await this.db.query(
        `UPDATE tasks SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ creator_notified: now }), t.id]
      );
    }

    // Group completed tasks by creator agent
    const byCreator = {};
    for (const task of tasks) {
      const creator = task.created_by_agent;
      if (!byCreator[creator]) byCreator[creator] = [];
      byCreator[creator].push(task);
    }

    const results = [];

    for (const [creatorId, creatorTasks] of Object.entries(byCreator)) {
      // Skip system/cron creators — they don't need notification
      if (creatorId === 'system' || creatorId === 'cron-template') continue;

      // Human creator — notify via SMS if escalation channel is configured
      if (creatorId === 'human') {
        const sent = await this._notifyHumanCompletion(creatorTasks);
        if (sent) {
          results.push({
            agent_id: 'human',
            method: 'sms',
            tasks: creatorTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
          });
        }
        continue;
      }

      // Check creator agent exists
      const creator = await this.db.getOne(
        'SELECT * FROM agent_availability WHERE agent_id = $1', [creatorId]
      );
      if (!creator) continue;

      // Build notification message
      const message = await this._formatCompletionNotification(creatorTasks);

      try {
        await this.wakeAgent(creatorId, message);
        this.log.info(`[task-system/dispatch] notified ${creatorId} of ${creatorTasks.length} completed task(s)`);

        results.push({
          agent_id: creatorId,
          tasks: creatorTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
        });
      } catch (e) {
        this.log.error(`[task-system/dispatch] failed to notify ${creatorId}: ${e.message}`);
      }
    }

    return { notified_count: results.length, details: results };
  }

  async _formatCompletionNotification(tasks) {
    const lines = ['Task Completion Notification:', ''];
    lines.push(`${tasks.length} task(s) you created have been completed:`, '');

    for (const t of tasks) {
      lines.push(`--- Task #${t.id}: "${t.title}" [${t.status.toUpperCase()}] ---`);

      // Get the final work log entry (the done/cancelled note)
      try {
        const finalLog = await this.db.getOne(
          `SELECT * FROM work_logs
           WHERE task_id = $1 AND action = 'status_change' AND status_to IN ('done', 'cancelled')
           ORDER BY created_at DESC LIMIT 1`,
          [t.id]
        );
        if (finalLog && finalLog.notes) {
          lines.push(`Result: ${finalLog.notes}`);
        }
      } catch (e) {
        this.log.error(`[task-system/dispatch] failed to get completion note for task #${t.id}: ${e.message}`);
      }

      // Include recent comments if any
      try {
        const comments = await this.db.getMany(
          `SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at DESC LIMIT 3`,
          [t.id]
        );
        if (comments.length > 0) {
          lines.push('Recent comments:');
          for (const c of comments) {
            lines.push(`  [${c.agent_id}]: ${c.content}`);
          }
        }
      } catch (e) { /* ignore */ }

      lines.push('');
    }

    lines.push('Review the results above. If any task result requires follow-up action (e.g., relaying information to a customer), take appropriate action now.');

    return lines.join('\n');
  }

  async _notifyHumanCompletion(tasks) {
    const channel = this.escalationConfig?.human_escalation_channel;
    const target  = this.escalationConfig?.human_escalation_target;
    const account = this.escalationConfig?.human_escalation_account;

    if (!channel || !target) {
      this.log.info('[task-system/dispatch] skipping human completion notify — no escalation channel configured');
      return false;
    }

    if (!this.runtime?.system?.runCommandWithTimeout) {
      this.log.error('[task-system/dispatch] runtime.system.runCommandWithTimeout not available for human notify');
      return false;
    }

    // Build SMS-friendly message with full result details
    const lines = [`${tasks.length} task(s) completed:`];
    for (const t of tasks) {
      lines.push(`\n#${t.id} "${t.title}" [${t.status}]`);
      // Get the final work log entry (done/cancelled note with full result)
      try {
        const finalLog = await this.db.getOne(
          `SELECT notes, agent_id FROM work_logs
           WHERE task_id = $1 AND action = 'status_change' AND status_to IN ('done', 'cancelled')
           ORDER BY created_at DESC LIMIT 1`,
          [t.id]
        );
        if (finalLog?.notes) {
          lines.push(`Result: ${finalLog.notes}`);
        }
      } catch (e) { /* ignore */ }
    }
    const messageText = lines.join('\n');

    const args = ['openclaw', 'message', 'send', '--channel', channel, '--target', target, '--message', messageText];
    if (account) args.push('--account', account);

    try {
      await this.runtime.system.runCommandWithTimeout(args, { timeoutMs: 30000 });
      this.log.info(`[task-system/dispatch] human notified via ${channel} of ${tasks.length} completed task(s)`);
      return true;
    } catch (err) {
      this.log.error(`[task-system/dispatch] failed to notify human via ${channel}: ${err.message}`);
      return false;
    }
  }

  // ── Agent Dispatch ──────────────────────────────────────────────────────────

  async dispatchAgents(maxPriority) {
    const agents = await this.db.getMany('SELECT * FROM agent_availability');
    const results = [];

    for (const agent of agents) {
      try {
        const result = await this._dispatchAgent(agent, maxPriority);
        if (result) results.push(result);
      } catch (e) {
        this.log.error(`[task-system/dispatch] error dispatching ${agent.agent_id}: ${e.message}`);
      }
    }

    return { agents_dispatched: results.length, details: results };
  }

  async _dispatchAgent(agent, maxPriority) {
    // Get all todo + unblocked + in_progress tasks assigned to this agent
    const priorityFilter = maxPriority ? `AND priority <= ${parseInt(maxPriority, 10)}` : '';
    const tasks = await this.db.getMany(
      `SELECT * FROM tasks
       WHERE assigned_to_agent = $1
         AND status IN ('todo', 'unblocked', 'in_progress')
         ${priorityFilter}
       ORDER BY priority ASC, deadline ASC NULLS LAST, created_at ASC`,
      [agent.agent_id]
    );

    if (tasks.length === 0) return null;

    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const todo = tasks.filter(t => t.status === 'todo' || t.status === 'unblocked');

    if (todo.length === 0) return null; // nothing new to dispatch

    // Check working hours — keep after_hours_auth tasks for later filtering
    const agentOnDuty = isWithinWorkingHours(agent) || agent.after_hours_capable;

    // Filter todo tasks: must be allowed right now
    const dispatchableTodo = todo.filter(t => {
      const { allowed } = isTaskAllowedNow(t, agent);
      return allowed;
    });

    // If agent is off duty and no after-hours tasks, skip
    if (!agentOnDuty && dispatchableTodo.length === 0) return null;

    // Filter out tasks still in dispatch cooldown or past max attempts
    const now = Date.now();
    const cooldownMs = this.config.dispatch_cooldown_minutes * 60000;
    const maxAttempts = this.config.max_dispatch_attempts;
    const readyTodo = dispatchableTodo.filter(t => {
      // Unblocked tasks always bypass cooldown — agent needs immediate notification
      if (t.status === 'unblocked') return true;
      const dispatchedAt = t.metadata?.dispatched_at;
      if (!dispatchedAt) return true;
      // Stop re-dispatching after max attempts — escalation engine handles it
      const count = t.metadata?.dispatch_count || 0;
      if (count >= maxAttempts) return false;
      return (now - new Date(dispatchedAt).getTime()) > cooldownMs;
    });

    if (readyTodo.length === 0 && inProgress.length === 0) return null;

    // Compute optimal active set from ALL eligible tasks (in_progress + ready todo)
    const maxConcurrent = agent.max_concurrent_tasks || 1;
    const eligible = [...inProgress, ...readyTodo]
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        if (aDeadline !== bDeadline) return aDeadline - bDeadline;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

    const activeSet = eligible.slice(0, maxConcurrent);
    const activeIds = new Set(activeSet.map(t => t.id));

    // Determine what needs to change
    const toStart = activeSet.filter(t => t.status === 'todo' || t.status === 'unblocked');
    const toPreempt = this.config.preemption_enabled
      ? inProgress.filter(t => !activeIds.has(t.id))
      : [];

    // Nothing to do if no new tasks to start and no preemptions
    if (toStart.length === 0 && toPreempt.length === 0) return null;

    // Execute preemptions
    for (const task of toPreempt) {
      const higherTask = toStart[0]; // the task that's bumping it
      await this.db.update('tasks', { status: 'todo' }, 'id = $1', [task.id]);

      await this.db.insert('work_logs', {
        task_id:     task.id,
        agent_id:    'system',
        action:      'status_change',
        status_from: 'in_progress',
        status_to:   'todo',
        notes:       `Preempted by higher priority task #${higherTask ? higherTask.id : '?'} (${PRIORITY_LABELS[higherTask?.priority] || '?'})`,
      });

      this.emit('task', { action: 'preempted', id: task.id });
      this.log.info(`[task-system/dispatch] task #${task.id} preempted (${PRIORITY_LABELS[task.priority]}) for task #${higherTask?.id} (${PRIORITY_LABELS[higherTask?.priority]})`);
    }

    // Mark dispatched tasks in metadata (track dispatch count)
    for (const task of toStart) {
      const meta = task.metadata || {};
      meta.dispatched_at = new Date().toISOString();
      meta.dispatch_count = (meta.dispatch_count || 0) + 1;
      await this.db.update('tasks', { metadata: JSON.stringify(meta) }, 'id = $1', [task.id]);
    }

    // Wake the agent
    const message = await this.formatDispatchMessage(toStart, toPreempt, activeSet);
    await this.wakeAgent(agent.agent_id, message);

    return {
      agent_id: agent.agent_id,
      started: toStart.map(t => ({ id: t.id, title: t.title, priority: PRIORITY_LABELS[t.priority] })),
      preempted: toPreempt.map(t => ({ id: t.id, title: t.title, priority: PRIORITY_LABELS[t.priority] })),
      active_set: activeSet.map(t => ({ id: t.id, title: t.title, priority: PRIORITY_LABELS[t.priority] })),
    };
  }

  // ── Message Formatting ──────────────────────────────────────────────────────

  async formatDispatchMessage(toStart, toPreempt, activeSet) {
    const lines = ['Task System Dispatch:', ''];

    if (toStart.length > 0) {
      lines.push('START these tasks:');
      for (const t of toStart) {
        let line = `- Task #${t.id} "${t.title}" [${PRIORITY_LABELS[t.priority] || t.priority}]`;
        if (t.deadline) line += ` — Deadline: ${new Date(t.deadline).toLocaleString('en-US', { timeZone: 'America/Toronto' })}`;
        if (t.status === 'unblocked') line += ' [UNBLOCKED — resuming]';
        lines.push(line);
      }
      lines.push('');
      lines.push('>>> FIRST: Call task_status(task_id, your_agent_id, "in_progress", "Starting work") for EACH task above BEFORE doing anything else.');
      lines.push('');

      // Include full transcript for each task to start
      for (const t of toStart) {
        try {
          const workLogs = await this.db.getMany(
            'SELECT * FROM work_logs WHERE task_id = $1 ORDER BY created_at ASC', [t.id]
          );
          const comments = await this.db.getMany(
            'SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC', [t.id]
          );
          const transcript = buildTaskTranscript(t, workLogs, comments);
          lines.push(`>>> FULL CONTEXT FOR TASK #${t.id}:`);
          lines.push(transcript);
          lines.push('');
        } catch (e) {
          this.log.error(`[task-system/dispatch] failed to build transcript for task #${t.id}: ${e.message}`);
        }
      }
    }

    if (toPreempt.length > 0) {
      lines.push('PAUSE these tasks (preempted by higher priority):');
      for (const t of toPreempt) {
        lines.push(`- Task #${t.id} "${t.title}" [${PRIORITY_LABELS[t.priority] || t.priority}]`);
      }
      lines.push('');
    }

    lines.push('Your active task list (by priority):');
    activeSet.forEach((t, i) => {
      let line = `${i + 1}. Task #${t.id} "${t.title}" [${PRIORITY_LABELS[t.priority] || t.priority}]`;
      if (t.deadline) line += ` — Deadline: ${new Date(t.deadline).toLocaleString('en-US', { timeZone: 'America/Toronto' })}`;
      lines.push(line);
    });

    return lines.join('\n');
  }

  // ── Agent Wake ──────────────────────────────────────────────────────────────

  async wakeAgent(agentId, message) {
    if (!this.runtime?.system?.runCommandWithTimeout) {
      this.log.error('[task-system/dispatch] runtime.system.runCommandWithTimeout not available');
      return;
    }

    const timeout = this.config.wake_timeout_seconds;

    try {
      await this.runtime.system.runCommandWithTimeout(
        ['openclaw', 'agent', '--agent', agentId, '--message', message, '--timeout', String(timeout)],
        { timeoutMs: timeout * 1000 + 10000 }
      );
      this.log.info(`[task-system/dispatch] woke agent ${agentId}`);
    } catch (e) {
      this.log.error(`[task-system/dispatch] failed to wake agent ${agentId}: ${e.message}`);
    }
  }
}

module.exports = { TaskDispatcher };

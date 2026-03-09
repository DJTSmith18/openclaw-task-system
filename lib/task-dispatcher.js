'use strict';

const fs = require('fs');
const path = require('path');
const { isWithinWorkingHours, isTaskAllowedNow } = require('./time-utils');
const { PRIORITY_LABELS } = require('./message-formatter');

class TaskDispatcher {
  constructor(db, runtime, logger, eventBus, config) {
    this.db = db;
    this.runtime = runtime;
    this.log = logger || { info: () => {}, error: () => {} };
    this.emit = (cat, detail) => { if (eventBus) eventBus.emit(cat, detail); };
    this.config = {
      dispatch_cooldown_minutes: config?.dispatch_cooldown_minutes || 15,
      priority_aging_minutes:    config?.priority_aging_minutes    || 60,
      preemption_enabled:        config?.preemption_enabled !== false,
      wake_timeout_seconds:      config?.wake_timeout_seconds      || 120,
    };
    this._workerRules = this._loadWorkerRules();
  }

  _loadWorkerRules() {
    try {
      return fs.readFileSync(path.join(__dirname, '..', 'agent-files', 'WORKER_RULES.md'), 'utf8');
    } catch {
      return 'RULES: (1) Set task to in_progress IMMEDIATELY. (2) NEVER ask questions in chat. (3) If blocked, set status to blocked with a clear reason. (4) Set done with a summary when complete.';
    }
  }

  // ── Main Entry ──────────────────────────────────────────────────────────────

  async dispatch() {
    const aging = await this.agePriorities();
    const dispatched = await this.dispatchAgents();
    return { aging, dispatched };
  }

  // ── Priority Aging ──────────────────────────────────────────────────────────

  async agePriorities() {
    const threshold = this.config.priority_aging_minutes;
    const tasks = await this.db.getMany(
      `SELECT * FROM tasks
       WHERE status = 'todo'
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

  // ── Agent Dispatch ──────────────────────────────────────────────────────────

  async dispatchAgents() {
    const agents = await this.db.getMany('SELECT * FROM agent_availability');
    const results = [];

    for (const agent of agents) {
      try {
        const result = await this._dispatchAgent(agent);
        if (result) results.push(result);
      } catch (e) {
        this.log.error(`[task-system/dispatch] error dispatching ${agent.agent_id}: ${e.message}`);
      }
    }

    return { agents_dispatched: results.length, details: results };
  }

  async _dispatchAgent(agent) {
    // Get all todo + in_progress tasks assigned to this agent
    const tasks = await this.db.getMany(
      `SELECT * FROM tasks
       WHERE assigned_to_agent = $1
         AND status IN ('todo', 'in_progress')
       ORDER BY priority ASC, deadline ASC NULLS LAST, created_at ASC`,
      [agent.agent_id]
    );

    if (tasks.length === 0) return null;

    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const todo = tasks.filter(t => t.status === 'todo');

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

    // Filter out tasks still in dispatch cooldown
    const now = Date.now();
    const cooldownMs = this.config.dispatch_cooldown_minutes * 60000;
    const readyTodo = dispatchableTodo.filter(t => {
      const dispatchedAt = t.metadata?.dispatched_at;
      if (!dispatchedAt) return true;
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
    const toStart = activeSet.filter(t => t.status === 'todo');
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

    // Mark dispatched tasks in metadata
    for (const task of toStart) {
      const meta = task.metadata || {};
      meta.dispatched_at = new Date().toISOString();
      await this.db.update('tasks', { metadata: JSON.stringify(meta) }, 'id = $1', [task.id]);
    }

    // Wake the agent
    const message = this.formatDispatchMessage(toStart, toPreempt, activeSet);
    await this.wakeAgent(agent.agent_id, message);

    return {
      agent_id: agent.agent_id,
      started: toStart.map(t => ({ id: t.id, title: t.title, priority: PRIORITY_LABELS[t.priority] })),
      preempted: toPreempt.map(t => ({ id: t.id, title: t.title, priority: PRIORITY_LABELS[t.priority] })),
      active_set: activeSet.map(t => ({ id: t.id, title: t.title, priority: PRIORITY_LABELS[t.priority] })),
    };
  }

  // ── Message Formatting ──────────────────────────────────────────────────────

  formatDispatchMessage(toStart, toPreempt, activeSet) {
    const lines = ['Task System Dispatch:', ''];

    if (toStart.length > 0) {
      lines.push('START these tasks:');
      for (const t of toStart) {
        let line = `- Task #${t.id} "${t.title}" [${PRIORITY_LABELS[t.priority] || t.priority}]`;
        if (t.deadline) line += ` — Deadline: ${new Date(t.deadline).toLocaleString('en-US', { timeZone: 'America/Toronto' })}`;
        lines.push(line);
      }
      lines.push('');
      lines.push('>>> FIRST: Call task_status(task_id, your_agent_id, "in_progress", "Starting work") for EACH task above BEFORE doing anything else.');
      lines.push('');
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

    lines.push('');
    lines.push('---');
    lines.push(this._workerRules);

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

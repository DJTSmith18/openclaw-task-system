'use strict';

const { minutesSince, minutesUntil, isWithinWorkingHours } = require('./time-utils');

class EscalationEngine {
  constructor(db, logger, runtime, eventBus, cfg) {
    this.db = db;
    this.log = logger || { info: () => {}, error: () => {} };
    this.runtime = runtime;
    this.eventBus = eventBus;
    this.cfg = cfg;
  }

  /**
   * Check for tasks stuck in_progress beyond the threshold.
   * Evaluates 'timeout' escalation rules.
   */
  async checkStuckTasks(thresholdOverride) {
    const rules = await this.db.getMany(
      `SELECT * FROM escalation_rules WHERE trigger_condition = 'timeout' AND enabled = TRUE`
    );

    const stuckTasks = [];

    for (const rule of rules) {
      const threshold = thresholdOverride || rule.timeout_minutes || 30;

      // Build category filter
      const catFilter = rule.task_category ? `AND t.category = '${rule.task_category}'` : '';
      const agentFilter = rule.from_agent ? `AND t.assigned_to_agent = '${rule.from_agent}'` : '';

      const tasks = await this.db.getMany(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'in_progress'
           AND t.updated_at < NOW() - INTERVAL '${threshold} minutes'
           ${catFilter} ${agentFilter}
         ORDER BY t.priority ASC`
      );

      for (const task of tasks) {
        // Check cooldown
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND rule_id = $2
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '${rule.cooldown_minutes || 30} minutes'`,
          [task.id, rule.id]
        );
        if (recentEsc) continue;

        // Check max escalations
        const escCount = await this.db.getCount(
          `SELECT COUNT(*) AS count FROM escalation_history WHERE task_id = $1 AND rule_id = $2`,
          [task.id, rule.id]
        );
        if (escCount >= (rule.max_escalations || 3)) continue;

        // Fire escalation
        await this._fireEscalation(task, rule, `Task stuck in_progress for ${minutesSince(task.updated_at)} minutes`);
        stuckTasks.push({ task_id: task.id, title: task.title, stuck_minutes: minutesSince(task.updated_at), escalated_to: rule.to_agent });
      }
    }

    return { stuck_tasks_found: stuckTasks.length, escalations: stuckTasks };
  }

  /**
   * Check for approaching or missed deadlines.
   * Evaluates 'deadline_approaching' and 'deadline_missed' escalation rules.
   */
  async checkDeadlines(warningOverride) {
    const results = { approaching: [], missed: [] };

    // Deadline approaching
    const approachingRules = await this.db.getMany(
      `SELECT * FROM escalation_rules WHERE trigger_condition = 'deadline_approaching' AND enabled = TRUE`
    );

    for (const rule of approachingRules) {
      const warningMinutes = warningOverride || rule.timeout_minutes || 30;
      const tasks = await this.db.getMany(
        `SELECT * FROM tasks
         WHERE status IN ('todo', 'in_progress')
           AND deadline IS NOT NULL
           AND deadline > NOW()
           AND deadline < NOW() + INTERVAL '${warningMinutes} minutes'
         ORDER BY deadline ASC`
      );

      for (const task of tasks) {
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND rule_id = $2
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '${rule.cooldown_minutes || 30} minutes'`,
          [task.id, rule.id]
        );
        if (recentEsc) continue;

        await this._fireEscalation(task, rule, `Deadline approaching: ${minutesUntil(task.deadline)} minutes remaining`);
        results.approaching.push({ task_id: task.id, title: task.title, deadline: task.deadline });
      }
    }

    // Deadline missed
    const missedRules = await this.db.getMany(
      `SELECT * FROM escalation_rules WHERE trigger_condition = 'deadline_missed' AND enabled = TRUE`
    );

    for (const rule of missedRules) {
      const tasks = await this.db.getMany(
        `SELECT * FROM tasks
         WHERE status IN ('todo', 'in_progress', 'blocked')
           AND deadline IS NOT NULL
           AND deadline < NOW()
         ORDER BY deadline ASC`
      );

      for (const task of tasks) {
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND rule_id = $2
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '${rule.cooldown_minutes || 30} minutes'`,
          [task.id, rule.id]
        );
        if (recentEsc) continue;

        await this._fireEscalation(task, rule, `Deadline missed by ${Math.abs(minutesUntil(task.deadline))} minutes`);
        results.missed.push({ task_id: task.id, title: task.title, deadline: task.deadline });
      }
    }

    return results;
  }

  /**
   * Check for blocked tasks and evaluate 'blocked' escalation rules.
   */
  async processBlockedTasks() {
    const rules = await this.db.getMany(
      `SELECT * FROM escalation_rules WHERE trigger_condition = 'blocked' AND enabled = TRUE`
    );

    const escalated = [];

    // Fallback: no rules configured — use hierarchy-based escalation
    if (rules.length === 0) {
      const blockedTasks = await this.db.getMany(
        `SELECT t.* FROM tasks t WHERE t.status = 'blocked'
         AND t.updated_at < NOW() - INTERVAL '30 minutes'
         ORDER BY t.priority ASC`
      );
      for (const task of blockedTasks) {
        // Check 30 min cooldown
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND trigger_condition = 'blocked'
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '30 minutes'`,
          [task.id]
        );
        if (recentEsc) continue;

        if (task.assigned_to_agent) {
          const lastNote = await this.db.getOne(
            `SELECT notes FROM work_logs WHERE task_id = $1 AND action = 'status_change' AND status_to = 'blocked' ORDER BY created_at DESC LIMIT 1`,
            [task.id]
          );
          await this.immediateBlockedEscalation(task.id, task.assigned_to_agent, lastNote?.notes || `Task blocked for ${minutesSince(task.updated_at)} minutes`);
          escalated.push({ task_id: task.id, title: task.title, escalated_to: 'hierarchy' });
        }
      }
      return { blocked_escalations: escalated.length, escalations: escalated };
    }

    for (const rule of rules) {
      const agentFilter = rule.from_agent ? `AND t.assigned_to_agent = '${rule.from_agent}'` : '';
      const catFilter = rule.task_category ? `AND t.category = '${rule.task_category}'` : '';
      const threshold = rule.timeout_minutes || 30;

      const tasks = await this.db.getMany(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'blocked'
           AND t.updated_at < NOW() - INTERVAL '${threshold} minutes'
           ${agentFilter} ${catFilter}
         ORDER BY t.priority ASC`
      );

      for (const task of tasks) {
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND rule_id = $2
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '${rule.cooldown_minutes || 30} minutes'`,
          [task.id, rule.id]
        );
        if (recentEsc) continue;

        const escCount = await this.db.getCount(
          `SELECT COUNT(*) AS count FROM escalation_history WHERE task_id = $1 AND rule_id = $2`,
          [task.id, rule.id]
        );
        if (escCount >= (rule.max_escalations || 3)) continue;

        await this._fireEscalation(task, rule, `Task blocked for ${minutesSince(task.updated_at)} minutes`);
        escalated.push({ task_id: task.id, title: task.title, escalated_to: rule.to_agent });
      }
    }

    return { blocked_escalations: escalated.length, escalations: escalated };
  }

  /**
   * Check for agents working on tasks outside their working hours.
   * Evaluates 'after_hours' escalation rules.
   */
  async checkAfterHours() {
    const rules = await this.db.getMany(
      `SELECT * FROM escalation_rules WHERE trigger_condition = 'after_hours' AND enabled = TRUE`
    );

    const escalated = [];

    for (const rule of rules) {
      const agentFilter = rule.from_agent ? `AND t.assigned_to_agent = '${rule.from_agent}'` : '';
      const catFilter = rule.task_category ? `AND t.category = '${rule.task_category}'` : '';

      const tasks = await this.db.getMany(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'in_progress'
           ${agentFilter} ${catFilter}
         ORDER BY t.priority ASC`
      );

      for (const task of tasks) {
        if (!task.assigned_to_agent) continue;

        const agent = await this.db.getOne(
          `SELECT * FROM agent_availability WHERE agent_id = $1`,
          [task.assigned_to_agent]
        );
        if (!agent) continue;

        // Skip if agent is within working hours or is after_hours_capable
        if (isWithinWorkingHours(agent) || agent.after_hours_capable) continue;
        // Skip if task has after_hours_auth
        if (task.after_hours_auth) continue;

        // Check cooldown
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND rule_id = $2
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '${rule.cooldown_minutes || 30} minutes'`,
          [task.id, rule.id]
        );
        if (recentEsc) continue;

        // Check max escalations
        const escCount = await this.db.getCount(
          `SELECT COUNT(*) AS count FROM escalation_history WHERE task_id = $1 AND rule_id = $2`,
          [task.id, rule.id]
        );
        if (escCount >= (rule.max_escalations || 3)) continue;

        await this._fireEscalation(task, rule, `Agent ${task.assigned_to_agent} is working on task after hours`);
        escalated.push({ task_id: task.id, title: task.title, agent: task.assigned_to_agent, escalated_to: rule.to_agent });
      }
    }

    return { after_hours_found: escalated.length, escalations: escalated };
  }

  /**
   * Check for urgent (priority=1) tasks idle too long.
   * Evaluates 'priority_urgent' escalation rules.
   */
  async checkUrgentTasks() {
    const rules = await this.db.getMany(
      `SELECT * FROM escalation_rules WHERE trigger_condition = 'priority_urgent' AND enabled = TRUE`
    );

    const escalated = [];

    for (const rule of rules) {
      const threshold = rule.timeout_minutes || 15;
      const catFilter = rule.task_category ? `AND t.category = '${rule.task_category}'` : '';
      const agentFilter = rule.from_agent ? `AND t.assigned_to_agent = '${rule.from_agent}'` : '';

      const tasks = await this.db.getMany(
        `SELECT t.* FROM tasks t
         WHERE t.priority = 1
           AND t.status IN ('todo', 'in_progress')
           AND t.updated_at < NOW() - INTERVAL '${threshold} minutes'
           ${catFilter} ${agentFilter}
         ORDER BY t.updated_at ASC`
      );

      for (const task of tasks) {
        // Check cooldown
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND rule_id = $2
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '${rule.cooldown_minutes || 30} minutes'`,
          [task.id, rule.id]
        );
        if (recentEsc) continue;

        // Check max escalations
        const escCount = await this.db.getCount(
          `SELECT COUNT(*) AS count FROM escalation_history WHERE task_id = $1 AND rule_id = $2`,
          [task.id, rule.id]
        );
        if (escCount >= (rule.max_escalations || 3)) continue;

        await this._fireEscalation(task, rule, `Urgent task unactioned for ${minutesSince(task.updated_at)} minutes`);
        escalated.push({ task_id: task.id, title: task.title, idle_minutes: minutesSince(task.updated_at), escalated_to: rule.to_agent });
      }
    }

    return { urgent_tasks_found: escalated.length, escalations: escalated };
  }

  /**
   * Check for tasks dispatched but never acknowledged (agent never set in_progress).
   * Evaluates 'unacknowledged' escalation rules.
   */
  async checkUnacknowledgedDispatches() {
    const rules = await this.db.getMany(
      `SELECT * FROM escalation_rules WHERE trigger_condition = 'unacknowledged' AND enabled = TRUE`
    );

    const escalated = [];

    for (const rule of rules) {
      const threshold = rule.timeout_minutes || 10;
      const maxAttempts = rule.max_escalations || 3;
      const catFilter = rule.task_category ? `AND t.category = '${rule.task_category}'` : '';
      const agentFilter = rule.from_agent ? `AND t.assigned_to_agent = '${rule.from_agent}'` : '';

      // Find todo tasks that were dispatched but never started
      const tasks = await this.db.getMany(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'todo'
           AND t.metadata->>'dispatched_at' IS NOT NULL
           AND (t.metadata->>'dispatched_at')::timestamptz < NOW() - INTERVAL '${threshold} minutes'
           AND COALESCE((t.metadata->>'dispatch_count')::int, 0) >= ${maxAttempts}
           ${catFilter} ${agentFilter}
         ORDER BY t.priority ASC`
      );

      for (const task of tasks) {
        // Check cooldown
        const recentEsc = await this.db.getOne(
          `SELECT * FROM escalation_history
           WHERE task_id = $1 AND rule_id = $2
             AND status IN ('acknowledged', 'resolved')
             AND created_at > NOW() - INTERVAL '${rule.cooldown_minutes || 30} minutes'`,
          [task.id, rule.id]
        );
        if (recentEsc) continue;

        const dispatchCount = task.metadata?.dispatch_count || 0;
        await this._fireEscalation(task, rule,
          `Task dispatched ${dispatchCount} times to ${task.assigned_to_agent || 'unknown'} but never acknowledged (agent never set in_progress)`
        );
        escalated.push({
          task_id: task.id,
          title: task.title,
          dispatch_count: dispatchCount,
          agent: task.assigned_to_agent,
          escalated_to: rule.to_agent,
        });
      }
    }

    return { unacknowledged_found: escalated.length, escalations: escalated };
  }

  /**
   * Immediately escalate a blocked task up the agent hierarchy.
   * Called directly from task_status when agent sets blocked, NOT from scheduler cycle.
   * @param {number} taskId
   * @param {string} agentId - the agent that blocked the task
   * @param {string} reason - the blocking reason (from note)
   */
  async immediateBlockedEscalation(taskId, agentId, reason) {
    const task = await this.db.getOne('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (!task) return;

    // Look up agent hierarchy
    const assignedAgent = task.assigned_to_agent || agentId;
    const agent = await this.db.getOne(
      'SELECT * FROM agent_availability WHERE agent_id = $1', [assignedAgent]
    );

    const supervisor = agent?.reports_to;
    if (!supervisor) return; // no hierarchy defined, rely on scheduled rules

    // Create escalation history as pending (no rule_id since this is immediate/hierarchy-based)
    const escalationMsg = `BLOCKED by ${assignedAgent}: ${reason}`;
    const escRecord = await this.db.insert('escalation_history', {
      task_id:           taskId,
      from_agent:        assignedAgent,
      to_agent:          supervisor,
      trigger_condition: 'blocked',
      message_sent:      escalationMsg,
    });

    // Update task escalation level
    const level = supervisor === 'human' ? 3 : (task.escalation_level || 0) + 1;
    await this.db.update('tasks', { escalation_level: level }, 'id = $1', [taskId]);

    // Log to work_logs
    await this.db.insert('work_logs', {
      task_id:  taskId,
      agent_id: 'system',
      action:   'escalation',
      notes:    `Immediately escalated to ${supervisor}: ${reason}`,
    });

    this.log.info(`[task-system/escalation] task #${taskId} immediately escalated to ${supervisor} (blocked)`);

    if (this.eventBus) {
      this.eventBus.emit('escalation', { action: 'triggered', task_id: taskId, to_agent: supervisor, trigger: 'blocked' });
    }

    // Wake the supervisor
    if (supervisor === 'human' && this.runtime?.system?.runCommandWithTimeout) {
      // Human escalation → scheduler agent gets a SHORT, directive message.
      // DO NOT include full transcript — it causes the scheduler to try to fix the problem.
      const schedulerAgentId = this.cfg?.scheduler?.agentId;
      if (schedulerAgentId) {
        const humanMsg = [
          `⚠ HUMAN ESCALATION REQUIRED — DO NOT ATTEMPT TO RESOLVE THIS YOURSELF`,
          ``,
          `Task #${taskId}: "${task.title}"`,
          `Blocked by: ${assignedAgent}`,
          `Reason: ${reason}`,
          ``,
          `YOUR ONLY ACTION: Send an SMS to the human informing them that Task #${taskId} is blocked and needs their attention.`,
          `Include the task number, title, and the blocked reason in the SMS.`,
          `DO NOT use any task tools. DO NOT try to fix, investigate, or work on this task. You are a scheduler, not a worker.`,
        ].join('\n');
        try {
          await this.runtime.system.runCommandWithTimeout(
            ['openclaw', 'agent', '--agent', schedulerAgentId, '--message', humanMsg, '--timeout', '120'],
            { timeoutMs: 130000 }
          );
          // Scheduler completed without error — mark escalation as resolved (SMS sent)
          await this.db.update('escalation_history', { status: 'resolved', response_at: new Date().toISOString() }, 'id = $1', [escRecord.id]);
        } catch (err) {
          this.log.error(`[task-system/escalation] failed to wake scheduler for human escalation: ${err.message}`);
        }
      }
    } else if (supervisor !== 'human' && this.runtime?.system?.runCommandWithTimeout) {
      // Agent supervisor gets the full transcript so they can actually help
      const { buildTaskTranscript } = require('./message-formatter');
      const workLogs = await this.db.getMany(
        'SELECT * FROM work_logs WHERE task_id = $1 ORDER BY created_at ASC', [taskId]
      );
      const comments = await this.db.getMany(
        'SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC', [taskId]
      );
      const transcript = buildTaskTranscript(task, workLogs, comments);
      const supervisorMsg = [
        `ESCALATION — Task Blocked`,
        '',
        escalationMsg,
        '',
        '--- Full Task Context ---',
        transcript,
        '',
        `Action required: Review the blocked reason and help unblock this task.`,
      ].join('\n');
      try {
        await this.runtime.system.runCommandWithTimeout(
          ['openclaw', 'agent', '--agent', supervisor, '--message', supervisorMsg, '--timeout', '120'],
          { timeoutMs: 130000 }
        );
        this.log.info(`[task-system/escalation] woke supervisor ${supervisor} for blocked task #${taskId}`);
      } catch (err) {
        this.log.error(`[task-system/escalation] failed to wake supervisor ${supervisor}: ${err.message}`);
      }
    }
  }

  /**
   * Fire an escalation: create history record, update task, log, wake agent.
   */
  async _fireEscalation(task, rule, message) {
    const { formatEscalationSMS } = require('./message-formatter');

    const smsMessage = rule.sms_template
      ? formatEscalationSMS(task, { trigger_condition: rule.trigger_condition, timeout_minutes: rule.timeout_minutes }, rule.sms_template)
      : message;

    const escRecord = await this.db.insert('escalation_history', {
      task_id:           task.id,
      rule_id:           rule.id,
      from_agent:        task.assigned_to_agent,
      to_agent:          rule.to_agent,
      trigger_condition: rule.trigger_condition,
      message_sent:      smsMessage,
    });

    // Update task escalation level
    const level = rule.to_agent === 'human' ? 3 : (task.escalation_level || 0) + 1;
    await this.db.update('tasks', { escalation_level: level }, 'id = $1', [task.id]);

    // Override priority if configured
    if (rule.priority_override && rule.priority_override < task.priority) {
      await this.db.update('tasks', { priority: rule.priority_override }, 'id = $1', [task.id]);
    }

    // Log to work_logs
    await this.db.insert('work_logs', {
      task_id:  task.id,
      agent_id: 'system',
      action:   'escalation',
      notes:    `Escalated to ${rule.to_agent}: ${message}`,
    });

    this.log.info(`[task-system/escalation] task #${task.id} escalated to ${rule.to_agent}: ${rule.trigger_condition}`);

    // Emit SSE event
    if (this.eventBus) {
      this.eventBus.emit('escalation', { action: 'triggered', task_id: task.id, to_agent: rule.to_agent, trigger: rule.trigger_condition });
    }

    // Wake the target agent (unless escalating to human)
    if (rule.to_agent !== 'human' && this.runtime?.system?.runCommandWithTimeout) {
      const wakeMsg = `ESCALATION: ${smsMessage} (Task #${task.id}: ${task.title})`;
      try {
        await this.runtime.system.runCommandWithTimeout(
          ['openclaw', 'agent', '--agent', rule.to_agent, '--message', wakeMsg, '--timeout', '120'],
          { timeoutMs: 130000 }
        );
        this.log.info(`[task-system/escalation] woke agent ${rule.to_agent} for task #${task.id}`);
      } catch (err) {
        this.log.error(`[task-system/escalation] failed to wake agent ${rule.to_agent}: ${err.message}`);
      }
    } else if (rule.to_agent === 'human' && this.runtime?.system?.runCommandWithTimeout) {
      // Wake the scheduler agent with a SHORT, directive message — DO NOT include full context
      const schedulerAgentId = this.cfg?.scheduler?.agentId;
      if (schedulerAgentId) {
        const lines = [
          `⚠ HUMAN ESCALATION REQUIRED — DO NOT ATTEMPT TO RESOLVE THIS YOURSELF`,
          ``,
          `Task #${task.id}: "${task.title}"`,
          `Status: ${task.status} | Priority: ${task.priority} | Assigned: ${task.assigned_to_agent || 'unassigned'}`,
          `Trigger: ${rule.trigger_condition}`,
          `Details: ${message}`,
        ];
        if (smsMessage && smsMessage !== message) {
          lines.push(`SMS text: ${smsMessage}`);
        }
        lines.push(
          ``,
          `YOUR ONLY ACTION: Send an SMS to the human with the above information.`,
          `DO NOT use any task tools. DO NOT try to fix, investigate, or work on this task. You are a scheduler, not a worker.`
        );
        const wakeMsg = lines.join('\n');
        try {
          await this.runtime.system.runCommandWithTimeout(
            ['openclaw', 'agent', '--agent', schedulerAgentId, '--message', wakeMsg, '--timeout', '120'],
            { timeoutMs: 130000 }
          );
          // Scheduler completed without error — mark escalation as resolved (SMS sent)
          await this.db.update('escalation_history', { status: 'resolved', response_at: new Date().toISOString() }, 'id = $1', [escRecord.id]);
          this.log.info(`[task-system/escalation] woke scheduler agent ${schedulerAgentId} for human escalation on task #${task.id}`);
        } catch (err) {
          this.log.error(`[task-system/escalation] failed to wake scheduler agent for human escalation: ${err.message}`);
        }
      }
    }
  }
}

module.exports = { EscalationEngine };

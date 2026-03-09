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
   * Fire an escalation: create history record, update task, log, wake agent.
   */
  async _fireEscalation(task, rule, message) {
    const { formatEscalationSMS } = require('./message-formatter');

    const smsMessage = rule.sms_template
      ? formatEscalationSMS(task, { trigger_condition: rule.trigger_condition, timeout_minutes: rule.timeout_minutes }, rule.sms_template)
      : message;

    await this.db.insert('escalation_history', {
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
      // Wake the scheduler agent with full context so it can notify a human
      const schedulerAgentId = this.cfg?.scheduler?.agentId;
      if (schedulerAgentId) {
        const lines = [
          `HUMAN ESCALATION — This requires immediate human attention.`,
          ``,
          `Task #${task.id}: ${task.title}`,
          `  Priority: ${task.priority} | Status: ${task.status} | Category: ${task.category || 'none'}`,
          `  Assigned agent: ${task.assigned_to_agent || 'unassigned'}`,
          `  Trigger: ${rule.trigger_condition} — ${message}`,
        ];
        if (smsMessage && smsMessage !== message) {
          lines.push(`  Notification template: ${smsMessage}`);
        }
        lines.push(``, `Use whatever channels you have available (Slack, email, SMS, etc.) to reach a human about this escalation.`);
        const wakeMsg = lines.join('\n');
        try {
          await this.runtime.system.runCommandWithTimeout(
            ['openclaw', 'agent', '--agent', schedulerAgentId, '--message', wakeMsg, '--timeout', '120'],
            { timeoutMs: 130000 }
          );
          this.log.info(`[task-system/escalation] woke scheduler agent ${schedulerAgentId} for human escalation on task #${task.id}`);
        } catch (err) {
          this.log.error(`[task-system/escalation] failed to wake scheduler agent for human escalation: ${err.message}`);
        }
      }
    }
  }
}

module.exports = { EscalationEngine };

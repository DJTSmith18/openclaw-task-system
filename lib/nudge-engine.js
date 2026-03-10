'use strict';

const { minutesSince } = require('./time-utils');

const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };

class NudgeEngine {
  constructor(db, runtime, logger, eventBus, cfg) {
    this.db = db;
    this.runtime = runtime;
    this.log = logger || { info: () => {}, error: () => {} };
    this.eventBus = eventBus;
    this.cfg = cfg;
    this.nudgeCfg = cfg?.nudge || {};
  }

  /** Run all nudge checks. Returns summary object. */
  async runAll() {
    if (this.nudgeCfg.enabled === false) {
      return { enabled: false };
    }
    const inProgress = await this.nudgeStuckInProgress();
    const blocked = await this.nudgeBlockedSupervisor();
    const unstarted = await this.nudgeUnstartedDispatched();
    return { in_progress_nudges: inProgress, blocked_nudges: blocked, unstarted_nudges: unstarted };
  }

  // ── In-Progress Nudge ───────────────────────────────────────────────────────

  /**
   * Nudge agents whose tasks have been in_progress too long without updates.
   * This fires BEFORE the escalation engine's checkStuckTasks().
   */
  async nudgeStuckInProgress() {
    const firstDelay = this.nudgeCfg.nudge_in_progress_minutes || 20;
    const interval = this.nudgeCfg.nudge_in_progress_interval_minutes || 15;
    const maxNudges = this.nudgeCfg.max_nudges || 5;

    const tasks = await this.db.getMany(
      `SELECT t.* FROM tasks t
       WHERE t.status = 'in_progress'
         AND t.assigned_to_agent IS NOT NULL
         AND t.updated_at < NOW() - INTERVAL '${firstDelay} minutes'
       ORDER BY t.priority ASC`
    );

    const nudged = [];
    for (const task of tasks) {
      const meta = task.metadata || {};
      const nudgeCount = meta.nudge_count || 0;

      // Stop nudging after max
      if (nudgeCount >= maxNudges) continue;

      // Check interval since last nudge
      if (meta.last_nudge_at) {
        const msSinceLast = Date.now() - new Date(meta.last_nudge_at).getTime();
        if (msSinceLast < interval * 60000) continue;
      }

      // Send nudge
      const stuckMin = minutesSince(task.updated_at);
      const message = `NUDGE: Task #${task.id} "${task.title}" [${PRIORITY_LABELS[task.priority] || task.priority}] has been in_progress for ${stuckMin} minutes with no updates. Please log progress, update status, or mark as blocked if you are stuck.`;

      await this._wakeAgent(task.assigned_to_agent, message);

      // Update metadata
      meta.last_nudge_at = new Date().toISOString();
      meta.nudge_count = nudgeCount + 1;
      await this.db.update('tasks', { metadata: JSON.stringify(meta) }, 'id = $1', [task.id]);

      // Log
      await this.db.insert('work_logs', {
        task_id: task.id, agent_id: 'system', action: 'nudge',
        notes: `Nudge #${meta.nudge_count} sent to ${task.assigned_to_agent}: in_progress for ${stuckMin} minutes`,
      });

      if (this.eventBus) this.eventBus.emit('nudge', { action: 'in_progress', task_id: task.id, agent: task.assigned_to_agent, count: meta.nudge_count });
      nudged.push({ task_id: task.id, agent: task.assigned_to_agent, stuck_minutes: stuckMin, nudge_number: meta.nudge_count });
    }

    return nudged;
  }

  // ── Blocked Nudge (to Supervisor) ───────────────────────────────────────────

  /**
   * Nudge the supervisor (agent or human) when a task is blocked too long.
   */
  async nudgeBlockedSupervisor() {
    const firstDelay = this.nudgeCfg.nudge_blocked_minutes || 15;
    const interval = this.nudgeCfg.nudge_blocked_interval_minutes || 15;
    const maxNudges = this.nudgeCfg.max_nudges || 5;

    const tasks = await this.db.getMany(
      `SELECT t.* FROM tasks t
       WHERE t.status = 'blocked'
         AND t.assigned_to_agent IS NOT NULL
         AND t.updated_at < NOW() - INTERVAL '${firstDelay} minutes'
       ORDER BY t.priority ASC`
    );

    const nudged = [];
    for (const task of tasks) {
      const meta = task.metadata || {};
      const nudgeCount = meta.blocked_nudge_count || 0;

      if (nudgeCount >= maxNudges) continue;

      // Check interval
      if (meta.last_blocked_nudge_at) {
        const msSinceLast = Date.now() - new Date(meta.last_blocked_nudge_at).getTime();
        if (msSinceLast < interval * 60000) continue;
      }

      // Find supervisor
      const agent = await this.db.getOne('SELECT reports_to FROM agent_availability WHERE agent_id = $1', [task.assigned_to_agent]);
      const supervisor = agent?.reports_to;
      if (!supervisor) continue; // No supervisor configured — skip, escalation rules handle it

      // Get the block reason from latest work log
      const blockLog = await this.db.getOne(
        `SELECT notes FROM work_logs WHERE task_id = $1 AND action = 'status_change' AND status_to = 'blocked' ORDER BY created_at DESC LIMIT 1`,
        [task.id]
      );
      const reason = blockLog?.notes || 'No reason provided';

      const blockedMin = minutesSince(task.updated_at);
      const message = `NUDGE: Task #${task.id} "${task.title}" [${PRIORITY_LABELS[task.priority] || task.priority}] assigned to ${task.assigned_to_agent} has been BLOCKED for ${blockedMin} minutes.\nReason: ${reason}\nPlease help resolve the blocker or reassign.`;

      if (supervisor === 'human') {
        await this._sendHumanMessage(message, task.id);
      } else {
        await this._wakeAgent(supervisor, message);
      }

      // Update metadata
      meta.last_blocked_nudge_at = new Date().toISOString();
      meta.blocked_nudge_count = nudgeCount + 1;
      await this.db.update('tasks', { metadata: JSON.stringify(meta) }, 'id = $1', [task.id]);

      await this.db.insert('work_logs', {
        task_id: task.id, agent_id: 'system', action: 'nudge',
        notes: `Blocked nudge #${meta.blocked_nudge_count} sent to supervisor ${supervisor}: blocked for ${blockedMin} minutes`,
      });

      if (this.eventBus) this.eventBus.emit('nudge', { action: 'blocked', task_id: task.id, supervisor, count: meta.blocked_nudge_count });
      nudged.push({ task_id: task.id, supervisor, blocked_minutes: blockedMin, nudge_number: meta.blocked_nudge_count });
    }

    return nudged;
  }

  // ── Unstarted Dispatched Nudge ──────────────────────────────────────────────

  /**
   * Nudge agents who were dispatched a task but haven't started it (still todo).
   * Only targets tasks with dispatched_at set (actually dispatched, within max_concurrent_tasks).
   */
  async nudgeUnstartedDispatched() {
    const firstDelay = this.nudgeCfg.nudge_unstarted_minutes || 10;
    const interval = this.nudgeCfg.nudge_unstarted_interval_minutes || 10;
    const maxNudges = this.nudgeCfg.max_nudges || 5;
    const maxDispatchAttempts = this.cfg?.dispatcher?.max_dispatch_attempts || 3;

    const tasks = await this.db.getMany(
      `SELECT t.* FROM tasks t
       WHERE t.status = 'todo'
         AND t.assigned_to_agent IS NOT NULL
         AND t.metadata->>'dispatched_at' IS NOT NULL
         AND (t.metadata->>'dispatched_at')::timestamptz < NOW() - INTERVAL '${firstDelay} minutes'
       ORDER BY t.priority ASC`
    );

    const nudged = [];
    for (const task of tasks) {
      const meta = task.metadata || {};

      // Skip if dispatch_count >= max_dispatch_attempts (escalation handles these)
      if ((meta.dispatch_count || 0) >= maxDispatchAttempts) continue;

      const nudgeCount = meta.unstarted_nudge_count || 0;
      if (nudgeCount >= maxNudges) continue;

      // Check interval
      if (meta.last_unstarted_nudge_at) {
        const msSinceLast = Date.now() - new Date(meta.last_unstarted_nudge_at).getTime();
        if (msSinceLast < interval * 60000) continue;
      }

      // Check for recent preemption — if task was preempted, don't nudge
      const preempted = await this.db.getOne(
        `SELECT id FROM work_logs WHERE task_id = $1 AND action = 'status_change' AND status_to = 'todo' AND notes LIKE 'Preempted%' AND created_at > $2 LIMIT 1`,
        [task.id, meta.dispatched_at]
      );
      if (preempted) continue;

      const dispatchedMin = minutesSince(meta.dispatched_at);
      const message = `NUDGE: Task #${task.id} "${task.title}" [${PRIORITY_LABELS[task.priority] || task.priority}] was dispatched to you ${dispatchedMin} minutes ago but is still in todo status. Please call task_status(${task.id}, your_agent_id, "in_progress") to start working on it, or update its status.`;

      await this._wakeAgent(task.assigned_to_agent, message);

      // Update metadata
      meta.last_unstarted_nudge_at = new Date().toISOString();
      meta.unstarted_nudge_count = nudgeCount + 1;
      await this.db.update('tasks', { metadata: JSON.stringify(meta) }, 'id = $1', [task.id]);

      await this.db.insert('work_logs', {
        task_id: task.id, agent_id: 'system', action: 'nudge',
        notes: `Unstarted nudge #${meta.unstarted_nudge_count} sent to ${task.assigned_to_agent}: dispatched ${dispatchedMin} minutes ago, still todo`,
      });

      if (this.eventBus) this.eventBus.emit('nudge', { action: 'unstarted', task_id: task.id, agent: task.assigned_to_agent, count: meta.unstarted_nudge_count });
      nudged.push({ task_id: task.id, agent: task.assigned_to_agent, dispatched_minutes: dispatchedMin, nudge_number: meta.unstarted_nudge_count });
    }

    return nudged;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async _wakeAgent(agentId, message) {
    if (!this.runtime?.system?.runCommandWithTimeout) {
      this.log.error(`[task-system/nudge] runtime not available — cannot wake agent ${agentId}`);
      return;
    }
    try {
      await this.runtime.system.runCommandWithTimeout(
        ['openclaw', 'agent', '--agent', agentId, '--message', message, '--timeout', '120'],
        { timeoutMs: 130000 }
      );
    } catch (err) {
      this.log.error(`[task-system/nudge] failed to wake agent ${agentId}: ${err.message}`);
    }
  }

  async _sendHumanMessage(messageText, taskId) {
    const esc = this.cfg?.escalation || {};
    const channel = esc.human_escalation_channel;
    const account = esc.human_escalation_account;
    const target = esc.human_escalation_target;

    if (!channel || !target) {
      this.log.error(`[task-system/nudge] human nudge not configured — set escalation.human_escalation_channel and human_escalation_target`);
      return;
    }
    if (!this.runtime?.system?.runCommandWithTimeout) {
      this.log.error(`[task-system/nudge] runtime not available for human nudge`);
      return;
    }

    const args = ['openclaw', 'message', 'send', '--channel', channel, '--target', target, '--message', messageText];
    if (account) args.push('--account', account);

    try {
      await this.runtime.system.runCommandWithTimeout(args, { timeoutMs: 30000 });
      this.log.info(`[task-system/nudge] human nudge sent via ${channel} for task #${taskId}`);
    } catch (err) {
      this.log.error(`[task-system/nudge] failed to send human nudge via ${channel}: ${err.message}`);
    }
  }
}

module.exports = { NudgeEngine };

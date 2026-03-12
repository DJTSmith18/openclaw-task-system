'use strict';

const { EscalationEngine } = require('./escalation-engine');
const { TaskDispatcher } = require('./task-dispatcher');

// ── Module-level state (same pattern as cron-task-runner.js) ─────────────────
let _normalInterval = null;
let _urgentInterval = null;
let _db = null;
let _runtime = null;
let _logger = null;
let _eventBus = null;
let _cfg = null;
let _lastNormalRun = 0;

// ── Shared scheduler cycle logic ─────────────────────────────────────────────
// Extracted from tools.js scheduler_run_cycle.
// Called by both the programmatic timer and the tool (for manual/diagnostic use).

async function runCycle({ db, runtime, logger, eventBus, cfg, urgentOnly, includeDiagnostics }) {
  const maxPriority = urgentOnly ? 1 : undefined;

  const engine = new EscalationEngine(db, logger, runtime, eventBus, cfg);

  // Diagnostic output — enabled via Settings > Debug > scheduler_diagnostics
  let diagnostics = undefined;
  if (includeDiagnostics) {
    diagnostics = {
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
  }

  const stuck = await engine.checkStuckTasks(undefined, maxPriority);
  const deadlines = await engine.checkDeadlines(undefined, maxPriority);
  const escalations = await engine.processBlockedTasks(maxPriority);

  // Skip after-hours, unacknowledged, and pending human escalation recovery in urgent mode
  const afterHours = urgentOnly ? { after_hours_found: 0, escalations: [] } : await engine.checkAfterHours();
  const urgent = await engine.checkUrgentTasks();
  const unacknowledged = urgentOnly ? { unacknowledged_found: 0, escalations: [] } : await engine.checkUnacknowledgedDispatches();

  // Check for unblocked tasks awaiting dispatch
  const priorityFilter = maxPriority ? `AND priority <= ${maxPriority}` : '';
  const unblockedTasks = await db.getMany(
    `SELECT id, title, assigned_to_agent, priority FROM tasks WHERE status = 'unblocked' ${priorityFilter} ORDER BY priority ASC`
  );

  // Process pending human escalations — skip in urgent mode (handled by full cycle)
  const pendingHumanEscalations = urgentOnly ? [] : await db.getMany(
    `SELECT eh.*, t.title AS task_title, t.status AS task_status, t.assigned_to_agent
     FROM escalation_history eh
     JOIN tasks t ON t.id = eh.task_id
     WHERE eh.status = 'pending' AND eh.to_agent = 'human'
     ORDER BY eh.created_at ASC`
  );

  const dispatcher = new TaskDispatcher(db, runtime, logger, eventBus, cfg?.scheduler, cfg?.escalation);
  const dispatch = await dispatcher.dispatch({ maxPriority });

  const result = {
    urgent_only: urgentOnly,
    stuck,
    deadlines,
    escalations,
    after_hours: afterHours,
    urgent,
    unacknowledged,
    unblocked_pending: unblockedTasks,
    pending_human_escalations: pendingHumanEscalations,
    dispatch,
    ran_at: new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }),
  };
  if (diagnostics) result.diagnostics = diagnostics;
  return result;
}

// ── Nudge system ─────────────────────────────────────────────────────────────

function minutesSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
}

async function wakeAgent(runtime, logger, agentId, message, timeoutSeconds) {
  if (!runtime?.system?.runCommandWithTimeout) {
    logger.error('[task-system/nudge] runtime.system.runCommandWithTimeout not available');
    return false;
  }
  const timeout = timeoutSeconds || 120;
  try {
    await runtime.system.runCommandWithTimeout(
      ['openclaw', 'agent', '--agent', agentId, '--message', message, '--timeout', String(timeout)],
      { timeoutMs: timeout * 1000 + 10000 }
    );
    return true;
  } catch (e) {
    logger.error(`[task-system/nudge] failed to wake agent ${agentId}: ${e.message}`);
    return false;
  }
}

async function updateNudgeMeta(db, taskId, currentMeta) {
  const meta = { ...currentMeta };
  meta.nudge_count = (meta.nudge_count || 0) + 1;
  meta.last_nudge_at = new Date().toISOString();
  await db.update('tasks', { metadata: JSON.stringify(meta) }, 'id = $1', [taskId]);
}

function shouldNudge(task, firstNudgeMinutes, intervalMinutes, maxNudges, timeField) {
  const meta = task.metadata || {};
  if ((meta.nudge_count || 0) >= maxNudges) return false;

  const elapsed = minutesSince(timeField);
  if (elapsed < firstNudgeMinutes) return false;

  // Check repeat interval
  if (meta.last_nudge_at) {
    const sinceLast = minutesSince(meta.last_nudge_at);
    if (sinceLast < intervalMinutes) return false;
  }

  return true;
}

async function runNudges({ db, runtime, logger, eventBus, cfg }) {
  const nudgeCfg = cfg?.nudge || {};
  if (nudgeCfg.enabled === false) return { nudge_count: 0 };

  const maxNudges = nudgeCfg.max_nudges || 5;
  const wakeTimeout = cfg?.scheduler?.wake_timeout_seconds || 120;
  let totalNudges = 0;

  // ── In-progress nudges: agent has task stuck in_progress ──────────────────
  const inProgressMinutes = nudgeCfg.nudge_in_progress_minutes || 20;
  const inProgressInterval = nudgeCfg.nudge_in_progress_interval_minutes || 15;

  const stuckInProgress = await db.getMany(
    `SELECT * FROM tasks
     WHERE status = 'in_progress'
       AND updated_at < NOW() - INTERVAL '${inProgressMinutes} minutes'
       AND assigned_to_agent IS NOT NULL
     ORDER BY priority ASC, updated_at ASC`
  );

  for (const task of stuckInProgress) {
    if (!shouldNudge(task, inProgressMinutes, inProgressInterval, maxNudges, task.updated_at)) continue;

    const elapsed = minutesSince(task.updated_at);
    const msg = `NUDGE: Task #${task.id} "${task.title}" has been in_progress for ${elapsed} minutes with no updates. Please update your progress using task_status, or set it to blocked if you're stuck.`;
    const sent = await wakeAgent(runtime, logger, task.assigned_to_agent, msg, wakeTimeout);
    if (sent) {
      await updateNudgeMeta(db, task.id, task.metadata || {});
      totalNudges++;
      logger.info(`[task-system/nudge] in_progress nudge sent to ${task.assigned_to_agent} for task #${task.id}`);
      if (eventBus) eventBus.emit('nudge', { action: 'sent', type: 'in_progress', task_id: task.id, agent: task.assigned_to_agent });
    }
  }

  // ── Blocked nudges: task blocked too long → nudge supervisor ──────────────
  const blockedMinutes = nudgeCfg.nudge_blocked_minutes || 15;
  const blockedInterval = nudgeCfg.nudge_blocked_interval_minutes || 15;

  const blockedTasks = await db.getMany(
    `SELECT t.*, aa.reports_to AS supervisor
     FROM tasks t
     LEFT JOIN agent_availability aa ON aa.agent_id = t.assigned_to_agent
     WHERE t.status = 'blocked'
       AND t.updated_at < NOW() - INTERVAL '${blockedMinutes} minutes'
     ORDER BY t.priority ASC, t.updated_at ASC`
  );

  for (const task of blockedTasks) {
    if (!shouldNudge(task, blockedMinutes, blockedInterval, maxNudges, task.updated_at)) continue;
    const supervisor = task.supervisor;
    if (!supervisor) continue; // No supervisor to nudge

    const elapsed = minutesSince(task.updated_at);
    const msg = `NUDGE: Task #${task.id} "${task.title}" assigned to ${task.assigned_to_agent || 'unassigned'} has been blocked for ${elapsed} minutes. Please review and help unblock it.`;
    const sent = await wakeAgent(runtime, logger, supervisor, msg, wakeTimeout);
    if (sent) {
      await updateNudgeMeta(db, task.id, task.metadata || {});
      totalNudges++;
      logger.info(`[task-system/nudge] blocked nudge sent to supervisor ${supervisor} for task #${task.id}`);
      if (eventBus) eventBus.emit('nudge', { action: 'sent', type: 'blocked', task_id: task.id, agent: supervisor });
    }
  }

  // ── Waiting nudges: task waiting too long → nudge assigned agent to follow up
  const waitingMinutes = nudgeCfg.nudge_waiting_minutes || 60;
  const waitingInterval = nudgeCfg.nudge_waiting_interval_minutes || 60;

  const waitingTasks = await db.getMany(
    `SELECT * FROM tasks
     WHERE status = 'waiting'
       AND updated_at < NOW() - INTERVAL '${waitingMinutes} minutes'
     ORDER BY priority ASC, updated_at ASC`
  );

  for (const task of waitingTasks) {
    if (!shouldNudge(task, waitingMinutes, waitingInterval, maxNudges, task.updated_at)) continue;
    if (!task.assigned_to_agent) continue;

    const elapsed = minutesSince(task.updated_at);
    const msg = `NUDGE: Task #${task.id} "${task.title}" has been waiting for a response for ${elapsed} minutes. Please follow up or check if a response was received.`;
    const sent = await wakeAgent(runtime, logger, task.assigned_to_agent, msg, wakeTimeout);
    if (sent) {
      await updateNudgeMeta(db, task.id, task.metadata || {});
      totalNudges++;
      logger.info(`[task-system/nudge] waiting nudge sent to ${task.assigned_to_agent} for task #${task.id}`);
      if (eventBus) eventBus.emit('nudge', { action: 'sent', type: 'waiting', task_id: task.id, agent: task.assigned_to_agent });
    }
  }

  // ── Unstarted nudges: dispatched but never started ────────────────────────
  const unstartedMinutes = nudgeCfg.nudge_unstarted_minutes || 10;
  const unstartedInterval = nudgeCfg.nudge_unstarted_interval_minutes || 10;

  const unstartedTasks = await db.getMany(
    `SELECT * FROM tasks
     WHERE status = 'todo'
       AND metadata->>'dispatched_at' IS NOT NULL
       AND (metadata->>'dispatched_at')::timestamptz < NOW() - INTERVAL '${unstartedMinutes} minutes'
       AND assigned_to_agent IS NOT NULL
     ORDER BY priority ASC`
  );

  for (const task of unstartedTasks) {
    const dispatchedAt = task.metadata?.dispatched_at;
    if (!dispatchedAt) continue;
    if (!shouldNudge(task, unstartedMinutes, unstartedInterval, maxNudges, dispatchedAt)) continue;

    const elapsed = minutesSince(dispatchedAt);
    const msg = `NUDGE: Task #${task.id} "${task.title}" was dispatched to you ${elapsed} minutes ago but hasn't been started. Please begin work by calling task_status to set it to in_progress.`;
    const sent = await wakeAgent(runtime, logger, task.assigned_to_agent, msg, wakeTimeout);
    if (sent) {
      await updateNudgeMeta(db, task.id, task.metadata || {});
      totalNudges++;
      logger.info(`[task-system/nudge] unstarted nudge sent to ${task.assigned_to_agent} for task #${task.id}`);
      if (eventBus) eventBus.emit('nudge', { action: 'sent', type: 'unstarted', task_id: task.id, agent: task.assigned_to_agent });
    }
  }

  return { nudge_count: totalNudges };
}

// ── Timer ticks ──────────────────────────────────────────────────────────────

async function normalTick() {
  if (!_db) return;
  _lastNormalRun = Date.now();
  try {
    const result = await runCycle({
      db: _db, runtime: _runtime, logger: _logger, eventBus: _eventBus, cfg: _cfg,
      urgentOnly: false, includeDiagnostics: false,
    });

    const nudges = await runNudges({
      db: _db, runtime: _runtime, logger: _logger, eventBus: _eventBus, cfg: _cfg,
    });

    const d = result.dispatch || {};
    _logger.info(
      `[task-system/scheduler-timer] cycle: ${result.stuck?.stuck_tasks_found || 0} stuck, ` +
      `${(result.deadlines?.approaching?.length || 0) + (result.deadlines?.missed?.length || 0)} deadline, ` +
      `${d.dispatched?.agents_dispatched || 0} dispatched, ` +
      `${nudges.nudge_count} nudges`
    );

    if (_eventBus) _eventBus.emit('scheduler', { action: 'cycle_complete', result, nudges });
  } catch (err) {
    _logger.error(`[task-system/scheduler-timer] normal cycle error: ${err.message}`);
  }
}

async function urgentTick() {
  if (!_db) return;
  // Skip if normal tick ran within last 10 seconds (overlap guard)
  if (Date.now() - _lastNormalRun < 10000) return;

  try {
    const result = await runCycle({
      db: _db, runtime: _runtime, logger: _logger, eventBus: _eventBus, cfg: _cfg,
      urgentOnly: true, includeDiagnostics: false,
    });

    // Only log if something actually happened
    const d = result.dispatch || {};
    const activity = (result.stuck?.stuck_tasks_found || 0) +
      (result.deadlines?.approaching?.length || 0) +
      (result.deadlines?.missed?.length || 0) +
      (d.dispatched?.agents_dispatched || 0);

    if (activity > 0) {
      _logger.info(
        `[task-system/scheduler-timer] urgent cycle: ${result.stuck?.stuck_tasks_found || 0} stuck, ` +
        `${(result.deadlines?.approaching?.length || 0) + (result.deadlines?.missed?.length || 0)} deadline, ` +
        `${d.dispatched?.agents_dispatched || 0} dispatched`
      );
    }
  } catch (err) {
    _logger.error(`[task-system/scheduler-timer] urgent cycle error: ${err.message}`);
  }
}

// ── Start / Stop ─────────────────────────────────────────────────────────────

function start(db, runtime, logger, eventBus, cfg) {
  _db = db;
  _runtime = runtime;
  _logger = logger || { info: () => {}, error: () => {} };
  _eventBus = eventBus || null;
  _cfg = cfg || {};

  const normalMs = (cfg?.scheduler?.checkIntervalMinutes || 5) * 60000;
  const urgentSeconds = cfg?.scheduler?.urgentCycleIntervalSeconds || 30;
  const urgentMs = urgentSeconds * 1000;
  const urgentEnabled = cfg?.scheduler?.urgentCycleEnabled !== false;

  _normalInterval = setInterval(normalTick, normalMs);

  if (urgentEnabled) {
    _urgentInterval = setInterval(urgentTick, urgentMs);
    _logger.info(`[task-system/scheduler-timer] started (normal=${normalMs}ms, urgent=${urgentMs}ms)`);
  } else {
    _logger.info(`[task-system/scheduler-timer] started (normal=${normalMs}ms, urgent=disabled)`);
  }

  // Run first tick after short delay to avoid startup race
  setTimeout(normalTick, 5000);
}

function stop() {
  if (_normalInterval) {
    clearInterval(_normalInterval);
    _normalInterval = null;
  }
  if (_urgentInterval) {
    clearInterval(_urgentInterval);
    _urgentInterval = null;
  }
}

module.exports = { runCycle, runNudges, start, stop };

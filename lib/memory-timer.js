'use strict';

// ── Memory Cycle Timer ────────────────────────────────────────────────────────
// Replaces cron-based memory scheduling with a programmatic timer.
// Checks every 60 seconds which agents are due for dream/rumination/sensor_sweep
// cycles, based on config in agent_availability.metadata.memory and
// last run time from dream_log.
//
// Dream: runs once daily at a configured time (run_at, default "03:00")
// Rumination: runs every N minutes (interval_minutes, default 240)
// Sensor Sweep: runs every N minutes (interval_minutes, default 120)

let _interval = null;
let _db = null;
let _runtime = null;
let _logger = null;
let _eventBus = null;
let _running = false;

const CYCLE_DEFAULTS = {
  dream:        { run_at: '03:00', timeout: 300 },
  rumination:   { interval_minutes: 240,  timeout: 180 },
  sensor_sweep: { interval_minutes: 120,  timeout: 120 },
};

function buildMessage(cycle, agentId) {
  switch (cycle) {
    case 'dream':
      return `Run nightly memory consolidation:\n1. Call memory_consolidate with agent_id "${agentId}" to run decay, archival, and pattern detection\n2. Review the pattern_candidates returned — for each with confidence >= "medium", decide if it represents a real, actionable pattern\n3. For real patterns, call memory_promote with the appropriate category, content, and confidence\n4. Call memory_status to verify system health\n5. Reply briefly with what was archived and promoted`;
    case 'rumination':
      return `Run rumination cycle:\n1. Call memory_recall with agent_id "${agentId}" to load recent observations and long-term memory\n2. Call task_query to review recent task activity (completed, blocked, escalated)\n3. Think across these threads: observation, reasoning, memory, planning\n   - OBSERVATION: What specific facts changed or are notable?\n   - REASONING: What non-obvious connections or implications do you see?\n   - MEMORY: What should be promoted to long-term memory?\n   - PLANNING: What should we proactively prepare for?\n4. For each insight worth recording, call memory_insight with thread type, importance (0-10), and tags\n5. Reply with a brief summary`;
    case 'sensor_sweep':
      return `Run sensor sweep — check system state and record notable changes:\n- Call task_query({"status":"blocked"}) — Blocked tasks\n- Call task_query({"deadline_within_hours":4}) — Approaching deadlines\n- Call agent_query({}) — Agent availability\n- Call escalation_query({"status":"pending"}) — Pending escalations\nFor each notable finding, call memory_observe with agent_id "${agentId}", source "sensor_sweep", and appropriate importance (0-10).\nSkip routine/unchanged data — only record what is new or changed. Reply briefly or HEARTBEAT_OK if nothing notable.`;
  }
}

/**
 * Check if a daily "run_at" time (HH:MM) is due based on last run.
 * Returns true if the target time has passed today and no run has happened since.
 */
function isDailyDue(runAt, lastRunMs, tz) {
  const [h, m] = (runAt || '03:00').split(':').map(Number);
  const now = new Date();

  // Build today's target time in the agent's timezone
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const targetDate = new Date(`${todayStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);

  // Adjust for timezone: get the offset difference
  const localTarget = new Date(targetDate.toLocaleString('en-US', { timeZone: tz }));
  const utcTarget = new Date(targetDate.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzOffsetMs = utcTarget.getTime() - localTarget.getTime();
  const targetMs = targetDate.getTime() + tzOffsetMs;

  const nowMs = now.getTime();

  // Target time hasn't passed yet today
  if (nowMs < targetMs) return false;

  // Target time has passed — check if we already ran after it
  if (lastRunMs >= targetMs) return false;

  // Don't fire if we're more than 2 hours past the target (avoid stale catch-up)
  if (nowMs - targetMs > 2 * 60 * 60 * 1000) return false;

  return true;
}

async function wakeAgent(agentId, message, timeoutSeconds) {
  if (!_runtime?.system?.runCommandWithTimeout) {
    _logger.error('[memory-timer] runtime.system.runCommandWithTimeout not available');
    return false;
  }
  const timeout = timeoutSeconds || 120;
  try {
    await _runtime.system.runCommandWithTimeout(
      ['openclaw', 'agent', '--agent', agentId, '--message', message, '--timeout', String(timeout)],
      { timeoutMs: timeout * 1000 + 10000 }
    );
    return true;
  } catch (e) {
    _logger.error(`[memory-timer] failed to wake agent ${agentId}: ${e.message}`);
    return false;
  }
}

async function tick() {
  if (!_db || _running) return;
  _running = true;

  try {
    // Get all agents with memory enabled
    const agents = await _db.getMany(
      `SELECT agent_id, timezone, metadata FROM agent_availability
       WHERE metadata->'memory'->>'enabled' = 'true'
       ORDER BY agent_id`
    );

    if (agents.length === 0) { _running = false; return; }

    // Get last run time for each agent+cycle from dream_log
    const lastRuns = await _db.getMany(
      `SELECT DISTINCT ON (agent_id, cycle_type)
              agent_id, cycle_type, created_at
       FROM dream_log
       ORDER BY agent_id, cycle_type, created_at DESC`
    );
    const lastRunMap = new Map();
    for (const r of lastRuns) {
      lastRunMap.set(`${r.agent_id}:${r.cycle_type}`, new Date(r.created_at).getTime());
    }

    const now = Date.now();
    const fired = [];

    for (const agent of agents) {
      const mem = agent.metadata?.memory || {};
      const tz = agent.timezone || 'America/Toronto';

      // ── Dream Cycle (daily at specific time) ──
      const dreamCfg = mem.dream || {};
      if (dreamCfg.enabled !== false) {
        const lastRun = lastRunMap.get(`${agent.agent_id}:dream`) || 0;
        const runAt = dreamCfg.run_at || CYCLE_DEFAULTS.dream.run_at;

        if (isDailyDue(runAt, lastRun, tz)) {
          const message = buildMessage('dream', agent.agent_id);
          const timeout = dreamCfg.timeout_seconds || CYCLE_DEFAULTS.dream.timeout;
          _logger.info(`[memory-timer] triggering dream for ${agent.agent_id} (scheduled ${runAt}, last: ${lastRun ? Math.round((now - lastRun) / 60000) + 'm ago' : 'never'})`);
          wakeAgent(agent.agent_id, message, timeout).catch(() => {});
          fired.push(`${agent.agent_id}:dream`);
        }
      }

      // ── Interval-based cycles (rumination, sensor_sweep) ──
      for (const cycle of ['rumination', 'sensor_sweep']) {
        const cycleCfg = mem[cycle] || {};
        if (cycleCfg.enabled === false) continue;

        const defaults = CYCLE_DEFAULTS[cycle];
        const intervalMs = (cycleCfg.interval_minutes || defaults.interval_minutes) * 60000;
        const timeout = cycleCfg.timeout_seconds || defaults.timeout;

        const lastRun = lastRunMap.get(`${agent.agent_id}:${cycle}`) || 0;
        const elapsed = now - lastRun;

        if (elapsed < intervalMs) continue;

        const message = buildMessage(cycle, agent.agent_id);
        _logger.info(`[memory-timer] triggering ${cycle} for ${agent.agent_id} (last: ${lastRun ? Math.round(elapsed / 60000) + 'm ago' : 'never'})`);
        wakeAgent(agent.agent_id, message, timeout).catch(() => {});
        fired.push(`${agent.agent_id}:${cycle}`);
      }
    }

    if (fired.length > 0) {
      _logger.info(`[memory-timer] triggered ${fired.length} cycle(s): ${fired.join(', ')}`);
    }
  } catch (err) {
    _logger.error(`[memory-timer] tick error: ${err.message}`);
  } finally {
    _running = false;
  }
}

function start(db, runtime, logger, eventBus) {
  _db = db;
  _runtime = runtime;
  _logger = logger || { info: () => {}, error: () => {} };
  _eventBus = eventBus || null;

  // Check every 60 seconds
  _interval = setInterval(tick, 60000);
  _logger.info('[memory-timer] started (60s tick)');

  // First tick after short delay
  setTimeout(tick, 10000);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

// Manual trigger (used by the Run Now button endpoint)
async function triggerCycle(agentId, cycle) {
  const message = buildMessage(cycle, agentId);
  const timeout = CYCLE_DEFAULTS[cycle]?.timeout || 120;
  return wakeAgent(agentId, message, timeout);
}

module.exports = { start, stop, triggerCycle };

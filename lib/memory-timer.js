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
const _inflightAgents = new Set(); // tracks agentIds with a running wake call

const CYCLE_DEFAULTS = {
  dream:        { run_at: '03:00', timeout: 300 },
  rumination:   { interval_minutes: 240,  timeout: 180 },
  sensor_sweep: { interval_minutes: 120,  timeout: 120 },
};

const DEFAULT_SWEEP_TOOLS = [
  { tool: 'task_query', params: { status: 'blocked' }, label: 'Blocked tasks' },
  { tool: 'task_query', params: { deadline_within_hours: 4 }, label: 'Approaching deadlines' },
  { tool: 'agent_query', params: {}, label: 'Agent availability' },
  { tool: 'escalation_query', params: { status: 'pending' }, label: 'Pending escalations' },
];

function buildMessage(cycle, agentId, cycleCfg) {
  switch (cycle) {
    case 'dream':
      return `Run nightly memory consolidation:\n1. Call memory_consolidate with agent_id "${agentId}" to run decay, archival, and pattern detection\n2. Review the pattern_candidates returned — for each with confidence >= "medium", decide if it represents a real, actionable pattern\n3. For real patterns, call memory_promote with the appropriate category, content, and confidence\n4. Call memory_status to verify system health\n5. Reply briefly with what was archived and promoted`;
    case 'rumination':
      return `Run rumination cycle:\n1. Call memory_recall with agent_id "${agentId}" to load recent observations and long-term memory\n2. Call task_query to review recent task activity (completed, blocked, escalated)\n3. Think across these threads: observation, reasoning, memory, planning\n   - OBSERVATION: What specific facts changed or are notable?\n   - REASONING: What non-obvious connections or implications do you see?\n   - MEMORY: What should be promoted to long-term memory?\n   - PLANNING: What should we proactively prepare for?\n4. For each insight worth recording, call memory_insight with thread type, importance (0-10), and tags\n5. Reply with a brief summary`;
    case 'sensor_sweep': {
      const tools = cycleCfg?.tools || DEFAULT_SWEEP_TOOLS;
      const toolLines = tools.map(t => `- Call ${t.tool}(${JSON.stringify(t.params)}) — ${t.label}`).join('\n');
      const defaultPrompt = `Run sensor sweep — check system state and record notable changes:\n${toolLines}\nFor each notable finding, call memory_observe with agent_id "${agentId}", source "sensor_sweep", and appropriate importance (0-10).\nSkip routine/unchanged data — only record what is new or changed. Reply briefly or HEARTBEAT_OK if nothing notable.`;

      if (cycleCfg?.prompt) {
        return cycleCfg.prompt
          .replace(/\{toolLines\}/g, toolLines)
          .replace(/\{agent_id\}/g, agentId);
      }
      return defaultPrompt;
    }
  }
}

/**
 * Check if a daily "run_at" time (HH:MM) is due based on last run.
 * Returns true if the target time has passed today (in the agent's timezone)
 * and no run has happened since that target time.
 */
function isDailyDue(runAt, lastRunMs, tz) {
  const [h, m] = (runAt || '03:00').split(':').map(Number);
  const now = new Date();

  // Get current date parts in agent's timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);

  const p = {};
  for (const { type, value } of parts) p[type] = value;

  const currentHour = parseInt(p.hour, 10);
  const currentMinute = parseInt(p.minute, 10);
  const currentMinutesOfDay = currentHour * 60 + currentMinute;
  const targetMinutesOfDay = h * 60 + m;

  // Target time hasn't passed yet today in agent's timezone
  if (currentMinutesOfDay < targetMinutesOfDay) return false;

  // Target time has passed — check if we already ran today
  // "Today" means: last run was after today's target time in agent TZ
  if (lastRunMs > 0) {
    // Get the date of the last run in agent's timezone
    const lastRunDate = new Date(lastRunMs);
    const lastParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(lastRunDate);
    const lp = {};
    for (const { type, value } of lastParts) lp[type] = value;
    const lastRunDateStr = `${lp.year}-${lp.month}-${lp.day}`;
    const todayDateStr = `${p.year}-${p.month}-${p.day}`;

    // Already ran today (or later) — skip
    if (lastRunDateStr >= todayDateStr) return false;
  }

  return true;
}

async function wakeAgent(agentId, message, timeoutSeconds) {
  if (!_runtime?.subagent?.run) {
    _logger.error('[memory-timer] runtime.subagent.run not available');
    return false;
  }
  const timeout = (timeoutSeconds || 120) * 1000;
  try {
    const { runId } = await _runtime.subagent.run({
      sessionKey: `memory:${agentId}`,
      message,
    });
    const result = await _runtime.subagent.waitForRun({ runId, timeoutMs: timeout });
    if (result.status !== 'ok') {
      _logger.error(`[memory-timer] agent ${agentId} run ${result.status}: ${result.error || ''}`);
      return false;
    }
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

    for (const agent of agents) {
      const agentId = agent.agent_id;

      // Skip if this agent already has a wake call running
      if (_inflightAgents.has(agentId)) continue;

      const mem = agent.metadata?.memory || {};
      const tz = agent.timezone || 'America/Toronto';

      // Collect due cycles for this agent into a sequential queue
      const queue = [];

      // ── Dream Cycle (daily at specific time) ──
      const dreamCfg = mem.dream || {};
      if (dreamCfg.enabled !== false) {
        const lastRun = lastRunMap.get(`${agentId}:dream`) || 0;
        const runAt = dreamCfg.run_at || CYCLE_DEFAULTS.dream.run_at;

        if (isDailyDue(runAt, lastRun, tz)) {
          const message = buildMessage('dream', agentId, dreamCfg);
          const timeout = dreamCfg.timeout_seconds || CYCLE_DEFAULTS.dream.timeout;
          queue.push({ cycle: 'dream', message, timeout, info: `scheduled ${runAt}, last: ${lastRun ? Math.round((now - lastRun) / 60000) + 'm ago' : 'never'}` });
        }
      }

      // ── Interval-based cycles (rumination, sensor_sweep) ──
      for (const cycle of ['rumination', 'sensor_sweep']) {
        const cycleCfg = mem[cycle] || {};
        if (cycleCfg.enabled === false) continue;

        const defaults = CYCLE_DEFAULTS[cycle];
        const intervalMs = (cycleCfg.interval_minutes || defaults.interval_minutes) * 60000;
        const timeout = cycleCfg.timeout_seconds || defaults.timeout;

        const lastRun = lastRunMap.get(`${agentId}:${cycle}`) || 0;
        const elapsed = now - lastRun;

        if (elapsed < intervalMs) continue;

        const message = buildMessage(cycle, agentId, cycleCfg);
        queue.push({ cycle, message, timeout, info: `last: ${lastRun ? Math.round(elapsed / 60000) + 'm ago' : 'never'}` });
      }

      if (queue.length === 0) continue;

      // Run due cycles sequentially for this agent (fire-and-forget the chain)
      _inflightAgents.add(agentId);
      const cycleNames = queue.map(q => q.cycle).join(', ');
      _logger.info(`[memory-timer] queuing ${queue.length} cycle(s) for ${agentId}: ${cycleNames}`);

      (async () => {
        for (const item of queue) {
          _logger.info(`[memory-timer] triggering ${item.cycle} for ${agentId} (${item.info})`);
          await wakeAgent(agentId, item.message, item.timeout);
        }
      })().finally(() => _inflightAgents.delete(agentId));
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
  if (!_runtime?.subagent?.run) {
    const msg = '[memory-timer] triggerCycle: runtime.subagent not available (start() may not have been called)';
    if (_logger) _logger.error(msg); else console.error(msg);
    return false;
  }

  if (_inflightAgents.has(agentId)) {
    _logger.info(`[memory-timer] manual trigger skipped — ${agentId} already has a cycle in flight`);
    return false;
  }

  // Load agent config for custom prompts
  let cycleCfg = {};
  if (_db) {
    try {
      const agent = await _db.getOne('SELECT metadata FROM agent_availability WHERE agent_id = $1', [agentId]);
      cycleCfg = agent?.metadata?.memory?.[cycle] || {};
    } catch (e) {
      _logger.error(`[memory-timer] triggerCycle: failed to load agent config: ${e.message}`);
    }
  }
  const message = buildMessage(cycle, agentId, cycleCfg);
  const timeout = CYCLE_DEFAULTS[cycle]?.timeout || 120;
  _logger.info(`[memory-timer] manual trigger: ${cycle} for ${agentId}`);
  _inflightAgents.add(agentId);
  try {
    return await wakeAgent(agentId, message, timeout);
  } finally {
    _inflightAgents.delete(agentId);
  }
}

module.exports = { start, stop, triggerCycle };

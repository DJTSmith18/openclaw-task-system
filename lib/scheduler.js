'use strict';

const fs = require('fs');
const crypto = require('crypto');

class Scheduler {
  constructor(opts) {
    this.db = opts.db;
    this.runtime = opts.runtime;
    this.log = opts.logger || { info: () => {}, error: () => {} };
    this.config = opts.config || {};
    this.cronFile = opts.cronFile;
  }

  /**
   * Initialize: ensure scheduler cron jobs exist in jobs.json.
   */
  async init() {
    try {
      await this.ensureCronJobs();
      this.log.info('[task-system/scheduler] initialized');
    } catch (err) {
      this.log.error('[task-system/scheduler] init error:', err.message);
    }
  }

  /**
   * Get the canonical job definitions.
   * Messages and settings defined here are the source of truth.
   * On every init, existing jobs' messages are updated to match.
   */
  // Scheduler Cycle and Urgent Cycle are now handled by programmatic timers
  // in lib/scheduler-timer.js. Only LLM-appropriate jobs remain here.
  _getJobSpecs(agentId, checkInterval) {
    return [
      {
        name: 'Task System: Morning Briefing',
        schedule: { kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/Toronto' },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: {
          kind: 'agentTurn',
          message: 'Morning task briefing: use task_query action=list to get all open tasks. Use task_summary for overview stats. Report the task status to the team.',
          timeoutSeconds: 180,
        },
        delivery: { mode: 'announce' },
      },
      {
        name: 'Task System: Daily Report',
        schedule: { kind: 'cron', expr: '0 17 * * 1-5', tz: 'America/Toronto' },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: {
          kind: 'agentTurn',
          message: 'End-of-day task report: use task_summary and worklog_time_report tools. Summarize tasks completed today, tasks still open, time spent by agent, and any overdue items.',
          timeoutSeconds: 180,
        },
        delivery: { mode: 'announce' },
      },
    ];
  }

  /**
   * Generate per-agent memory cron jobs for agents with memory enabled.
   */
  async _getMemoryJobSpecs() {
    const specs = [];

    try {
      const agents = await this.db.getMany(
        `SELECT agent_id, timezone, metadata FROM agent_availability
         WHERE metadata->'memory'->>'enabled' = 'true'
         ORDER BY agent_id`
      );

      for (const agent of agents) {
        const mem = agent.metadata?.memory || {};
        const tz = agent.timezone || 'America/Toronto';

        // Dream Cycle
        if (mem.dream?.enabled !== false) {
          const dreamCfg = mem.dream || {};
          specs.push({
            name: `Memory: Dream Cycle (${agent.agent_id})`,
            agentId: agent.agent_id,
            schedule: { kind: 'cron', expr: dreamCfg.schedule || '0 3 * * *', tz },
            sessionTarget: 'isolated',
            wakeMode: 'now',
            payload: {
              kind: 'agentTurn',
              message: `Run nightly memory consolidation:\n1. Call memory_consolidate with agent_id "${agent.agent_id}" to run decay, archival, and pattern detection\n2. Review the pattern_candidates returned — for each with confidence >= "medium", decide if it represents a real, actionable pattern\n3. For real patterns, call memory_promote with the appropriate category, content, and confidence\n4. Call memory_status to verify system health\n5. Reply briefly with what was archived and promoted`,
              timeoutSeconds: 300,
            },
            delivery: { mode: 'none' },
          });
        }

        // Rumination
        if (mem.rumination?.enabled !== false) {
          const rumCfg = mem.rumination || {};
          const threads = rumCfg.threads || ['observation', 'reasoning', 'memory', 'planning'];
          const maxImportance = rumCfg.max_importance_for_escalation || 8.5;
          specs.push({
            name: `Memory: Rumination (${agent.agent_id})`,
            agentId: agent.agent_id,
            schedule: { kind: 'cron', expr: rumCfg.schedule || '0 */4 * * *', tz },
            sessionTarget: 'isolated',
            wakeMode: 'now',
            payload: {
              kind: 'agentTurn',
              message: `Run rumination cycle:\n1. Call memory_recall with agent_id "${agent.agent_id}" to load recent observations and long-term memory\n2. Call task_query to review recent task activity (completed, blocked, escalated)\n3. Think across these threads: ${threads.join(', ')}\n   - OBSERVATION: What specific facts changed or are notable?\n   - REASONING: What non-obvious connections or implications do you see?\n   - MEMORY: What should be promoted to long-term memory?\n   - PLANNING: What should we proactively prepare for?\n4. For each insight worth recording, call memory_insight with thread type, importance (0-10), and tags\n5. If any insight has importance >= ${maxImportance}, use escalation_trigger to alert\n6. Reply with a brief summary`,
              timeoutSeconds: 180,
            },
            delivery: { mode: 'none' },
          });
        }

        // Sensor Sweep
        if (mem.sensor_sweep?.enabled !== false) {
          const sweepCfg = mem.sensor_sweep || {};
          const tools = sweepCfg.tools || [
            { tool: 'task_query', params: { status: 'blocked' }, label: 'Blocked tasks' },
            { tool: 'task_query', params: { deadline_within_hours: 4 }, label: 'Approaching deadlines' },
            { tool: 'agent_query', params: {}, label: 'Agent availability' },
            { tool: 'escalation_query', params: { status: 'pending' }, label: 'Pending escalations' },
          ];
          const toolLines = tools.map(t => `- Call ${t.tool}(${JSON.stringify(t.params)}) — ${t.label}`).join('\n');
          specs.push({
            name: `Memory: Sensor Sweep (${agent.agent_id})`,
            agentId: agent.agent_id,
            schedule: { kind: 'cron', expr: sweepCfg.schedule || '0 */2 * * *', tz },
            sessionTarget: 'isolated',
            wakeMode: 'now',
            payload: {
              kind: 'agentTurn',
              message: `Run sensor sweep — check system state and record notable changes:\n${toolLines}\nFor each notable finding, call memory_observe with agent_id "${agent.agent_id}", source "sensor_sweep", and appropriate importance (0-10).\nSkip routine/unchanged data — only record what is new or changed. Reply briefly or HEARTBEAT_OK if nothing notable.`,
              timeoutSeconds: sweepCfg.timeout_seconds || 120,
            },
            delivery: { mode: 'none' },
          });
        }
      }
    } catch (err) {
      this.log.error(`[task-system/scheduler] failed to load memory-enabled agents: ${err.message}`);
    }

    return specs;
  }

  /**
   * Ensure the task-system cron jobs are registered and up to date.
   * Creates missing jobs, updates messages on existing ones,
   * and removes stale memory jobs for agents that disabled memory.
   */
  async ensureCronJobs() {
    if (!this.cronFile || !fs.existsSync(this.cronFile)) {
      this.log.info('[task-system/scheduler] cron file not found, skipping job registration');
      return;
    }

    const agentId = this.config.agentId;
    if (!agentId) {
      this.log.info('[task-system/scheduler] no scheduler agentId configured, skipping cron registration');
      return;
    }

    const data = JSON.parse(fs.readFileSync(this.cronFile, 'utf8'));
    const jobsByName = new Map(data.jobs.map(j => [j.name, j]));
    const checkInterval = this.config.checkIntervalMinutes || 5;

    // Gather all specs: core task-system jobs + per-agent memory jobs
    const coreSpecs = this._getJobSpecs(agentId, checkInterval);
    const memorySpecs = await this._getMemoryJobSpecs();
    const allSpecs = [...coreSpecs, ...memorySpecs];

    // Track which spec names we expect — anything prefixed "Memory:" not in this
    // set is stale (agent disabled memory) and should be removed.
    const expectedNames = new Set(allSpecs.map(s => s.name));

    let added = 0;
    let updated = 0;
    let removed = 0;

    for (const spec of allSpecs) {
      const existing = jobsByName.get(spec.name);

      if (existing) {
        // Update message, schedule, or agentId if changed
        let changed = false;
        if (existing.payload?.message !== spec.payload.message) {
          existing.payload.message = spec.payload.message;
          existing.payload.timeoutSeconds = spec.payload.timeoutSeconds;
          changed = true;
        }
        if (JSON.stringify(existing.schedule) !== JSON.stringify(spec.schedule)) {
          existing.schedule = spec.schedule;
          changed = true;
        }
        if (spec.agentId && existing.agentId !== spec.agentId) {
          existing.agentId = spec.agentId;
          changed = true;
        }
        if (changed) {
          existing.updatedAtMs = Date.now();
          updated++;
        }
      } else {
        // Create new job — memory jobs use their own agentId
        data.jobs.push({
          id: crypto.randomUUID(),
          agentId: spec.agentId || agentId,
          name: spec.name,
          enabled: true,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          schedule: spec.schedule,
          sessionTarget: spec.sessionTarget,
          wakeMode: spec.wakeMode,
          payload: spec.payload,
          delivery: spec.delivery,
          state: {},
        });
        added++;
      }
    }

    // Remove stale jobs: defunct scheduler/urgent cycles (now programmatic timers),
    // and disabled memory features
    const before = data.jobs.length;
    data.jobs = data.jobs.filter(j => {
      if (j.name === 'Task System: Scheduler Cycle') return false;
      if (j.name === 'Task System: Urgent Cycle') return false;
      if (j.name.startsWith('Memory:') && !expectedNames.has(j.name)) {
        return false;
      }
      return true;
    });
    removed = before - data.jobs.length;

    if (added > 0 || updated > 0 || removed > 0) {
      fs.writeFileSync(this.cronFile, JSON.stringify(data, null, 2));
      if (added > 0) this.log.info(`[task-system/scheduler] registered ${added} cron jobs`);
      if (updated > 0) this.log.info(`[task-system/scheduler] updated ${updated} cron job messages`);
      if (removed > 0) this.log.info(`[task-system/scheduler] removed ${removed} stale cron jobs`);
    }
  }
}

module.exports = { Scheduler };

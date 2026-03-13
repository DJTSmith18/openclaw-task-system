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
   * Ensure the task-system cron jobs are registered and up to date.
   * Creates missing jobs, updates messages on existing ones,
   * and cleans up defunct jobs.
   * Note: Memory cycles (dream, rumination, sensor_sweep) are handled by
   * lib/memory-timer.js — no longer managed via cron.
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

    const allSpecs = this._getJobSpecs(agentId, checkInterval);
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

    // Remove stale jobs: defunct scheduler/urgent cycles and memory cron jobs
    // (all now handled by programmatic timers)
    const before = data.jobs.length;
    data.jobs = data.jobs.filter(j => {
      if (j.name === 'Task System: Scheduler Cycle') return false;
      if (j.name === 'Task System: Urgent Cycle') return false;
      if (j.name.startsWith('Memory:')) return false; // migrated to memory-timer.js
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

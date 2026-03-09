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
  _getJobSpecs(agentId, checkInterval) {
    return [
      {
        name: 'Task System: Scheduler Cycle',
        schedule: { kind: 'every', everyMs: checkInterval * 60000, anchorMs: Date.now() },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: {
          kind: 'agentTurn',
          message: 'Run the task system scheduler cycle: use the scheduler_run_cycle tool. Report any escalations triggered and any unblocked tasks pending dispatch. IMPORTANT: If the result includes pending_human_escalations (non-empty array), you MUST send an SMS to the human for EACH pending escalation — include the task number, title, blocked reason, and who blocked it. After sending each SMS, use escalation_respond with response "resolve" to mark it delivered.',
          timeoutSeconds: 120,
        },
        delivery: { mode: 'none' },
      },
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
   * Creates missing jobs and updates messages on existing ones.
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
    const specs = this._getJobSpecs(agentId, checkInterval);

    let added = 0;
    let updated = 0;

    for (const spec of specs) {
      const existing = jobsByName.get(spec.name);

      if (existing) {
        // Update message if it changed (keeps id, schedule, enabled state, etc.)
        if (existing.payload?.message !== spec.payload.message) {
          existing.payload.message = spec.payload.message;
          existing.payload.timeoutSeconds = spec.payload.timeoutSeconds;
          existing.updatedAtMs = Date.now();
          updated++;
        }
      } else {
        // Create new job
        data.jobs.push({
          id: crypto.randomUUID(),
          agentId,
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

    if (added > 0 || updated > 0) {
      fs.writeFileSync(this.cronFile, JSON.stringify(data, null, 2));
      if (added > 0) this.log.info(`[task-system/scheduler] registered ${added} cron jobs`);
      if (updated > 0) this.log.info(`[task-system/scheduler] updated ${updated} cron job messages`);
    }
  }
}

module.exports = { Scheduler };

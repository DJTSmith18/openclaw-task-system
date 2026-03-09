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
   * Ensure the task-system cron jobs are registered.
   * Only adds jobs that don't already exist (by checking name prefix).
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
    const existing = new Set(data.jobs.map(j => j.name));
    let added = 0;

    const checkInterval = this.config.checkIntervalMinutes || 5;

    // Scheduler cycle job
    if (!existing.has('Task System: Scheduler Cycle')) {
      data.jobs.push({
        id: crypto.randomUUID(),
        agentId,
        name: 'Task System: Scheduler Cycle',
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: {
          kind: 'every',
          everyMs: checkInterval * 60000,
          anchorMs: Date.now(),
        },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: {
          kind: 'agentTurn',
          message: 'Run the task system scheduler cycle: use the scheduler_run_cycle tool. Report any escalations triggered and any unblocked tasks pending dispatch.',
          timeoutSeconds: 120,
        },
        delivery: { mode: 'none' },
        state: {},
      });
      added++;
    }

    // Morning briefing job
    if (!existing.has('Task System: Morning Briefing')) {
      data.jobs.push({
        id: crypto.randomUUID(),
        agentId,
        name: 'Task System: Morning Briefing',
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: {
          kind: 'cron',
          expr: '0 8 * * 1-5',
          tz: 'America/Toronto',
        },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: {
          kind: 'agentTurn',
          message: 'Morning task briefing: use task_query action=list to get all open tasks. Use task_summary for overview stats. Report the task status to the team.',
          timeoutSeconds: 180,
        },
        delivery: { mode: 'announce' },
        state: {},
      });
      added++;
    }

    // Daily report job
    if (!existing.has('Task System: Daily Report')) {
      data.jobs.push({
        id: crypto.randomUUID(),
        agentId,
        name: 'Task System: Daily Report',
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: {
          kind: 'cron',
          expr: '0 17 * * 1-5',
          tz: 'America/Toronto',
        },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: {
          kind: 'agentTurn',
          message: 'End-of-day task report: use task_summary and worklog_time_report tools. Summarize tasks completed today, tasks still open, time spent by agent, and any overdue items.',
          timeoutSeconds: 180,
        },
        delivery: { mode: 'announce' },
        state: {},
      });
      added++;
    }

    if (added > 0) {
      fs.writeFileSync(this.cronFile, JSON.stringify(data, null, 2));
      this.log.info(`[task-system/scheduler] registered ${added} cron jobs`);
    }
  }
}

module.exports = { Scheduler };

'use strict';
const { Router } = require('express');
const fs = require('fs');
const crypto = require('crypto');

module.exports = function ({ cronFile, eventBus }) {
  const r = Router();

  function readJobs() {
    if (!fs.existsSync(cronFile)) return { version: 1, jobs: [] };
    return JSON.parse(fs.readFileSync(cronFile, 'utf8'));
  }

  function writeJobs(data) {
    fs.writeFileSync(cronFile, JSON.stringify(data, null, 2));
  }

  r.get('/cron/jobs', (req, res) => {
    try {
      const data = readJobs();
      let jobs = data.jobs || [];
      if (req.query.agent_id) jobs = jobs.filter(j => j.agentId === req.query.agent_id);
      res.json({ jobs, total: jobs.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/cron/jobs', (req, res) => {
    try {
      const b = req.body;
      if (!b.agentId || !b.name || !b.schedule || !b.message) {
        return res.status(400).json({ error: 'agentId, name, schedule, message required' });
      }
      const data = readJobs();
      const job = {
        id: crypto.randomUUID(),
        agentId: b.agentId,
        name: b.name,
        enabled: b.enabled !== false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: b.schedule,
        sessionTarget: b.sessionTarget || 'isolated',
        wakeMode: b.wakeMode || 'now',
        payload: {
          kind: 'agentTurn',
          message: b.message,
          timeoutSeconds: b.timeoutSeconds || 120,
        },
        delivery: b.delivery || { mode: 'none' },
        state: {},
      };
      data.jobs.push(job);
      writeJobs(data);
      if (eventBus) eventBus.emit('cron', { action: 'created', id: job.id });
      res.status(201).json(job);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.put('/cron/jobs/:id', (req, res) => {
    try {
      const data = readJobs();
      const job = data.jobs.find(j => j.id === req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const b = req.body;
      if (b.name)           job.name = b.name;
      if (b.agentId)        job.agentId = b.agentId;
      if (b.enabled !== undefined) job.enabled = b.enabled;
      if (b.schedule)       job.schedule = b.schedule;
      if (b.sessionTarget)  job.sessionTarget = b.sessionTarget;
      if (b.wakeMode)       job.wakeMode = b.wakeMode;
      if (b.message)        job.payload.message = b.message;
      if (b.timeoutSeconds) job.payload.timeoutSeconds = b.timeoutSeconds;
      if (b.delivery)       job.delivery = b.delivery;
      job.updatedAtMs = Date.now();
      writeJobs(data);
      if (eventBus) eventBus.emit('cron', { action: 'updated', id: job.id });
      res.json(job);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.delete('/cron/jobs/:id', (req, res) => {
    try {
      const data = readJobs();
      const before = data.jobs.length;
      data.jobs = data.jobs.filter(j => j.id !== req.params.id);
      if (data.jobs.length === before) return res.status(404).json({ error: 'Job not found' });
      writeJobs(data);
      if (eventBus) eventBus.emit('cron', { action: 'deleted', id: req.params.id });
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.patch('/cron/jobs/:id/toggle', (req, res) => {
    try {
      const data = readJobs();
      const job = data.jobs.find(j => j.id === req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      job.enabled = !job.enabled;
      job.updatedAtMs = Date.now();
      writeJobs(data);
      if (eventBus) eventBus.emit('cron', { action: 'toggled', id: job.id });
      res.json(job);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

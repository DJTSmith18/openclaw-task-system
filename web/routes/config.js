'use strict';
const { Router } = require('express');
const { PermissionResolver, GROUPS, ALIASES } = require('../../lib/permissions');

// Default values for all configurable settings
const DEFAULTS = {
  general: { timezone: 'America/Toronto' },
  scheduler: { agentId: '', checkIntervalMinutes: 5, stuckThresholdMinutes: 30, deadlineWarningMinutes: 30, cleanupDays: 30 },
  dispatcher: { dispatch_cooldown_minutes: 15, priority_aging_minutes: 60, preemption_enabled: true, wake_timeout_seconds: 120, unack_threshold_minutes: 10, max_dispatch_attempts: 3 },
  escalation: { default_timeout_minutes: 30, default_cooldown_minutes: 30, default_max_escalations: 3 },
  debug: { scheduler_diagnostics: false },
  database: { host: 'localhost', port: 5432, database: 'openclaw_tasks', user: 'openclaw', password: '', maxConnections: 10 },
  webUI: { port: 18790, host: '0.0.0.0', authToken: '', enabled: true },
};

// Which sections require a restart to take effect
const RESTART_SECTIONS = new Set(['database', 'webUI']);

// Validation rules per section
const VALIDATORS = {
  general: { timezone: 'string' },
  scheduler: { agentId: 'string', checkIntervalMinutes: 'posint', stuckThresholdMinutes: 'posint', deadlineWarningMinutes: 'posint', cleanupDays: 'posint' },
  dispatcher: { dispatch_cooldown_minutes: 'posint', priority_aging_minutes: 'posint', preemption_enabled: 'boolean', wake_timeout_seconds: 'posint', unack_threshold_minutes: 'posint', max_dispatch_attempts: 'posint' },
  escalation: { default_timeout_minutes: 'posint', default_cooldown_minutes: 'posint', default_max_escalations: 'posint' },
  debug: { scheduler_diagnostics: 'boolean' },
  database: { host: 'string', port: 'port', database: 'string', user: 'string', password: 'password', maxConnections: 'posint' },
  webUI: { port: 'port', host: 'string', authToken: 'string', enabled: 'boolean' },
};

function validateValue(val, rule) {
  switch (rule) {
    case 'string':   return typeof val === 'string';
    case 'posint':   return typeof val === 'number' && Number.isInteger(val) && val > 0;
    case 'port':     return typeof val === 'number' && Number.isInteger(val) && val >= 1 && val <= 65535;
    case 'boolean':  return typeof val === 'boolean';
    case 'password': return typeof val === 'string';
    default:         return true;
  }
}

module.exports = function ({ db, eventBus, permissionResolver, openclawJsonPath, cfg }) {
  const r = Router();
  const fs = require('fs');

  r.get('/config', async (req, res) => {
    try {
      const dbHealth = await db.ping();
      const schemaVersion = await db.getOne('SELECT MAX(version) AS version FROM schema_version');
      res.json({
        database: {
          connected: dbHealth.ok,
          pool: dbHealth.pool,
          schema_version: schemaVersion?.version || 0,
        },
        permissions: {
          groups: PermissionResolver.describeGroups(),
          aliases: PermissionResolver.describeAliases(),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/config/health', async (req, res) => {
    try {
      const dbHealth = await db.ping();
      const taskCount = await db.getCount('SELECT COUNT(*) AS count FROM tasks');
      res.json({
        status: dbHealth.ok ? 'healthy' : 'unhealthy',
        database: dbHealth,
        task_count: taskCount,
        timestamp: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/config/permissions', (req, res) => {
    res.json({
      groups: PermissionResolver.describeGroups(),
      aliases: PermissionResolver.describeAliases(),
      agentPermissions: permissionResolver ? permissionResolver.getAllAgentPermissions() : {},
    });
  });

  // ── Update agent permissions (runtime + persist to openclaw.json) ───────────
  r.put('/config/permissions', (req, res) => {
    try {
      const { agentPermissions } = req.body;
      if (!agentPermissions || typeof agentPermissions !== 'object') {
        return res.status(400).json({ error: 'agentPermissions object required' });
      }

      // Validate: each value must be an array of strings
      for (const [agentId, groups] of Object.entries(agentPermissions)) {
        if (!Array.isArray(groups)) {
          return res.status(400).json({ error: `Permissions for "${agentId}" must be an array` });
        }
        if (!groups.every(g => typeof g === 'string')) {
          return res.status(400).json({ error: `All entries for "${agentId}" must be strings` });
        }
      }

      // Update runtime permissions
      if (permissionResolver) {
        permissionResolver.replaceAllPermissions(agentPermissions);
      }

      // Persist to openclaw.json
      if (openclawJsonPath) {
        try {
          const raw = fs.readFileSync(openclawJsonPath, 'utf8');
          const config = JSON.parse(raw);

          // Ensure nested path exists
          if (!config.plugins) config.plugins = {};
          if (!config.plugins.entries) config.plugins.entries = {};
          if (!config.plugins.entries['task-system']) config.plugins.entries['task-system'] = {};
          if (!config.plugins.entries['task-system'].config) config.plugins.entries['task-system'].config = {};

          config.plugins.entries['task-system'].config.agentPermissions = agentPermissions;

          fs.writeFileSync(openclawJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
        } catch (fileErr) {
          // Runtime update succeeded but persist failed — report partial success
          return res.json({
            ok: true,
            warning: `Runtime updated but failed to persist to ${openclawJsonPath}: ${fileErr.message}`,
            agentPermissions: permissionResolver ? permissionResolver.getAllAgentPermissions() : agentPermissions,
          });
        }
      }

      if (eventBus) eventBus.emit('config', { action: 'permissions_updated' });
      res.json({
        ok: true,
        agentPermissions: permissionResolver ? permissionResolver.getAllAgentPermissions() : agentPermissions,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Read all settings (merged with defaults) ────────────────────────────────
  r.get('/config/settings', (req, res) => {
    try {
      let fileCfg = {};
      if (openclawJsonPath) {
        try {
          const raw = fs.readFileSync(openclawJsonPath, 'utf8');
          fileCfg = JSON.parse(raw)?.plugins?.entries?.['task-system']?.config || {};
        } catch { /* use empty */ }
      }

      const settings = {};
      for (const [section, defaults] of Object.entries(DEFAULTS)) {
        const source = section === 'general' ? fileCfg : (fileCfg[section] || {});
        settings[section] = {};
        for (const [key, defaultVal] of Object.entries(defaults)) {
          if (section === 'general') {
            settings[section][key] = fileCfg[key] !== undefined ? fileCfg[key] : defaultVal;
          } else {
            settings[section][key] = source[key] !== undefined ? source[key] : defaultVal;
          }
        }
      }

      // Mask password
      if (settings.database.password) {
        settings.database.password = '••••••';
      }

      res.json({ settings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Update a settings section ──────────────────────────────────────────────
  r.put('/config/settings', (req, res) => {
    try {
      const { section, values } = req.body;
      if (!section || !values || typeof values !== 'object') {
        return res.status(400).json({ error: 'section (string) and values (object) required' });
      }

      const rules = VALIDATORS[section];
      if (!rules) {
        return res.status(400).json({ error: `Unknown section: ${section}` });
      }

      // Validate each provided value
      for (const [key, val] of Object.entries(values)) {
        if (!rules[key]) {
          return res.status(400).json({ error: `Unknown setting: ${section}.${key}` });
        }
        // Skip masked password
        if (rules[key] === 'password' && val === '••••••') continue;
        if (!validateValue(val, rules[key])) {
          return res.status(400).json({ error: `Invalid value for ${section}.${key}: expected ${rules[key]}` });
        }
      }

      // Read, update, write openclaw.json
      if (!openclawJsonPath) {
        return res.status(500).json({ error: 'openclaw.json path not configured' });
      }

      const raw = fs.readFileSync(openclawJsonPath, 'utf8');
      const config = JSON.parse(raw);

      // Ensure nested path
      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      if (!config.plugins.entries['task-system']) config.plugins.entries['task-system'] = {};
      if (!config.plugins.entries['task-system'].config) config.plugins.entries['task-system'].config = {};

      const pluginCfg = config.plugins.entries['task-system'].config;

      if (section === 'general') {
        // General settings live at root of plugin config
        for (const [key, val] of Object.entries(values)) {
          pluginCfg[key] = val;
        }
      } else {
        if (!pluginCfg[section]) pluginCfg[section] = {};
        for (const [key, val] of Object.entries(values)) {
          // Skip masked password
          if (VALIDATORS[section][key] === 'password' && val === '••••••') continue;
          pluginCfg[section][key] = val;
        }
      }

      fs.writeFileSync(openclawJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

      // Update in-memory cfg so changes take effect without restart
      // (only for sections that don't require restart)
      if (cfg && !RESTART_SECTIONS.has(section)) {
        if (section === 'general') {
          for (const [key, val] of Object.entries(values)) {
            cfg[key] = val;
          }
        } else {
          if (!cfg[section]) cfg[section] = {};
          for (const [key, val] of Object.entries(values)) {
            if (VALIDATORS[section][key] === 'password' && val === '••••••') continue;
            cfg[section][key] = val;
          }
        }
      }

      const requiresRestart = RESTART_SECTIONS.has(section);
      if (eventBus) eventBus.emit('config', { action: 'settings_updated', section });

      res.json({ ok: true, requiresRestart });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

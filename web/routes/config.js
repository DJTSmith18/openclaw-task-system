'use strict';
const { Router } = require('express');
const { PermissionResolver, GROUPS, ALIASES } = require('../../lib/permissions');

module.exports = function ({ db, eventBus, permissionResolver, openclawJsonPath }) {
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

  return r;
};

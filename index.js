'use strict';

const { Database } = require('./lib/db');
const { PermissionResolver } = require('./lib/permissions');
const { buildTools } = require('./lib/tools');
const { Scheduler } = require('./lib/scheduler');
const { WebServer } = require('./web/server');
const { EventBus } = require('./lib/event-bus');

// ── Plugin entry point ────────────────────────────────────────────────────────
module.exports = function (api) {

  // ── Config ─────────────────────────────────────────────────────────────────
  const cfg = api.config?.plugins?.entries?.['task-system']?.config || {};

  // ── Database ───────────────────────────────────────────────────────────────
  const db = new Database({
    host:     cfg.database?.host     || process.env.TASK_DB_HOST     || 'localhost',
    port:     cfg.database?.port     || process.env.TASK_DB_PORT     || 5432,
    database: cfg.database?.database || process.env.TASK_DB_NAME     || 'openclaw_tasks',
    user:     cfg.database?.user     || process.env.TASK_DB_USER     || 'openclaw',
    password: cfg.database?.password || process.env.TASK_DB_PASSWORD || '',
    timezone: cfg.timezone || 'America/Toronto',
  });

  // ── Event Bus ──────────────────────────────────────────────────────────────
  const eventBus = new EventBus();

  // ── Permissions ────────────────────────────────────────────────────────────
  const perms = new PermissionResolver(cfg.agentPermissions);

  // ── Tools ──────────────────────────────────────────────────────────────────
  const allTools = buildTools(db, api.runtime, api.logger, eventBus, cfg);

  // Register tool factory — called once per agent turn.
  // Returns only the tools this agent is allowed to use.
  api.registerTool((ctx) => {
    if (!ctx.agentId) return null;
    return perms.filterToolsForAgent(allTools, ctx.agentId);
  });

  // ── Web UI Channel ─────────────────────────────────────────────────────────
  const webCfg = cfg.webUI || {};
  if (webCfg.enabled !== false) {
    let activeServer = null;

    api.registerChannel({
      id: 'task-system-ui',
      meta: {
        id:             'task-system-ui',
        label:          'Task System',
        selectionLabel: 'Task System',
        docsPath:       'task-system',
        blurb:          'Web-based task orchestration dashboard with webhook listener and API',
      },
      capabilities: { chatTypes: [] },

      config: {
        listAccountIds: () => ['default'],
        resolveAccount:  () => ({ enabled: true }),
        isEnabled:       () => true,
        isConfigured:    () => true,
      },

      heartbeat: {
        checkReady: async () => {
          const ok = activeServer?._server?.listening ?? false;
          return { ok, reason: ok ? 'listening' : 'not started' };
        },
      },

      gateway: {
        startAccount: async ({ abortSignal }) => {
          const cronFile = (process.env.HOME || '/root') + '/.openclaw/cron/jobs.json';

          const openclawJsonPath = (process.env.HOME || '/root') + '/.openclaw/openclaw.json';

          // Run pending database migrations
          try {
            const applied = await db.runMigrations();
            if (applied.length) api.logger.info(`[task-system] applied migrations: ${applied.join(', ')}`);
          } catch (err) {
            api.logger.error(`[task-system] migration error: ${err.message}`);
          }

          activeServer = new WebServer({
            port:      webCfg.port      || 18790,
            host:      webCfg.host      || '0.0.0.0',
            authToken: webCfg.authToken || '',
            db,
            cronFile,
            runtime: api.runtime,
            logger:  api.logger,
            permissionResolver: perms,
            openclawJsonPath,
            eventBus,
            cfg,
          });

          await activeServer.start(abortSignal);
        },

        stopAccount: async () => {
          if (activeServer) {
            activeServer.stop();
            activeServer = null;
          }
          api.logger.info('[task-system] web server stopped');
        },
      },

      outbound: {
        deliveryMode: 'direct',
        sendText: async () => ({ ok: true }), // no-op — inbound-only channel
      },
    });
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────
  const cronFile = (process.env.HOME || '/root') + '/.openclaw/cron/jobs.json';
  const scheduler = new Scheduler({
    db,
    runtime: api.runtime,
    logger:  api.logger,
    config:  cfg.scheduler || {},
    escalationConfig: cfg.escalation || {},
    cronFile,
  });
  scheduler.init().catch((err) => {
    api.logger.error('[task-system] scheduler init failed:', err.message);
  });

  api.logger.info('[task-system] plugin loaded');
};

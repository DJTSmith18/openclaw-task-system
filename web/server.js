'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createWebhookRouter } = require('../lib/webhook-listener');
const cronTaskRunner = require('../lib/cron-task-runner');
const schedulerTimer = require('../lib/scheduler-timer');
const memoryTimer = require('../lib/memory-timer');

class WebServer {
  constructor(opts) {
    this.port = opts.port || 18790;
    this.host = opts.host || '0.0.0.0';
    this.authToken = opts.authToken || '';
    this.db = opts.db;
    this.cronFile = opts.cronFile;
    this.runtime = opts.runtime;
    this.logger = opts.logger || { info: () => {}, error: () => {} };
    this.permissionResolver = opts.permissionResolver || null;
    this.openclawJsonPath = opts.openclawJsonPath || '';
    this.eventBus = opts.eventBus || null;
    this.cfg = opts.cfg || {};
    this._server = null;
  }

  async start(abortSignal) {
    const app = express();

    // ── Raw body capture for HMAC verification ──────────────────────────────
    app.use((req, res, next) => {
      if (req.path.startsWith('/webhooks/')) {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => { req.rawBody = data; });
      }
      next();
    });

    app.use(express.json({ limit: '5mb' }));
    app.use(cors());

    // ── Auth middleware for /dashboard/api/* routes ──────────────────────────
    const authMiddleware = (req, res, next) => {
      if (!this.authToken) return next(); // no auth configured
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
      if (token === this.authToken) return next();
      res.status(401).json({ error: 'Unauthorized' });
    };

    // ── Webhook routes (no auth — uses per-source HMAC) ─────────────────────
    app.use(createWebhookRouter({ db: this.db, logger: this.logger }));

    // ── Auth verify (before general auth middleware) ───────────────────────
    app.post('/dashboard/api/auth/verify', (req, res) => {
      if (!this.authToken) return res.json({ ok: true });
      const token = req.body.token || '';
      if (token === this.authToken) return res.json({ ok: true });
      res.status(401).json({ ok: false, error: 'Invalid token' });
    });

    // ── API routes (auth required) ──────────────────────────────────────────
    app.use('/dashboard/api', authMiddleware);

    const routeOpts = { db: this.db, cronFile: this.cronFile, logger: this.logger, eventBus: this.eventBus };
    const configOpts = { ...routeOpts, permissionResolver: this.permissionResolver, openclawJsonPath: this.openclawJsonPath, cfg: this.cfg, runtime: this.runtime };

    if (this.eventBus) {
      app.use('/dashboard/api', require('./routes/sse')(routeOpts));
    }

    app.use('/dashboard/api', require('./routes/tasks')(routeOpts));
    app.use('/dashboard/api', require('./routes/worklogs')(routeOpts));
    app.use('/dashboard/api', require('./routes/comments')(routeOpts));
    app.use('/dashboard/api', require('./routes/agents')(routeOpts));
    app.use('/dashboard/api', require('./routes/escalations')(routeOpts));
    app.use('/dashboard/api', require('./routes/webhooks')(routeOpts));
    app.use('/dashboard/api', require('./routes/cron')(routeOpts));
    app.use('/dashboard/api', require('./routes/task-templates')(routeOpts));
    app.use('/dashboard/api', require('./routes/dashboard')(routeOpts));
    app.use('/dashboard/api', require('./routes/memory')(routeOpts));
    app.use('/dashboard/api', require('./routes/config')(configOpts));

    // ── Static files (built React app) ──────────────────────────────────────
    const uiDist = path.join(__dirname, 'ui', 'dist');
    // Hashed assets (*.js, *.css) get long cache; index.html never cached
    app.use('/dashboard/assets', express.static(path.join(uiDist, 'assets'), {
      maxAge: '30d',
      immutable: true,
    }));
    app.use('/dashboard', express.static(uiDist, {
      etag: false,
      maxAge: 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        }
      },
    }));
    // SPA fallback — serve index.html for any /dashboard/* route
    app.get('/dashboard/*', (req, res) => {
      if (!req.path.startsWith('/dashboard/api') && !req.path.startsWith('/dashboard/webhooks')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.sendFile(path.join(uiDist, 'index.html'));
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    });
    // Redirect bare /dashboard to /dashboard/
    app.get('/dashboard', (req, res) => res.redirect('/dashboard/'));

    // ── Start server ────────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {
      // Start cron task template runner
      cronTaskRunner.start(this.db, this.logger, this.eventBus);
      // Start programmatic scheduler timers (replaces scheduler agent cron jobs)
      schedulerTimer.start(this.db, this.runtime, this.logger, this.eventBus, this.cfg);
      // Start memory cycle timer (dream, rumination, sensor sweep)
      memoryTimer.start(this.db, this.runtime, this.logger, this.eventBus);

      this._server = app.listen(this.port, this.host, () => {
        this.logger.info(`[task-system] web server listening on ${this.host}:${this.port}`);
      });

      this._server.on('error', (err) => {
        this.logger.error(`[task-system] web server error: ${err.message}`);
        reject(err);
      });

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          this.stop();
          resolve();
        }, { once: true });
      }
    });
  }

  stop() {
    cronTaskRunner.stop();
    schedulerTimer.stop();
    memoryTimer.stop();
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }
}

module.exports = { WebServer };

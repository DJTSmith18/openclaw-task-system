'use strict';

const crypto = require('crypto');
const { flattenPayload, processWebhookEvent } = require('./webhook-templates');

/**
 * Create Express router for the universal webhook listener.
 * Mounts at /webhooks/:slug
 * @param {object} opts - { db, logger }
 * @returns {import('express').Router}
 */
function createWebhookRouter(opts) {
  const { Router } = require('express');
  const router = Router();
  const { db, logger } = opts;
  const log = logger || { info: () => {}, error: () => {} };

  // POST /webhooks/:slug — Universal webhook receiver
  router.post('/webhooks/:slug', async (req, res) => {
    const { slug } = req.params;

    try {
      // 1. Look up source
      const source = await db.getOne('SELECT * FROM webhook_sources WHERE slug = $1', [slug]);
      if (!source) {
        return res.status(404).json({ error: 'Unknown webhook source', slug });
      }
      if (!source.enabled) {
        return res.status(410).json({ error: 'Webhook source disabled', slug });
      }

      // 2. Verify HMAC signature if configured
      if (source.secret) {
        const signature = req.headers['x-webhook-signature']
          || req.headers['x-hub-signature-256']
          || req.headers['x-signature'];

        if (!signature) {
          return res.status(401).json({ error: 'Missing webhook signature' });
        }

        const rawBody = req.rawBody || JSON.stringify(req.body);
        const digest = crypto.createHmac('sha256', source.secret).update(rawBody).digest('hex');

        // Normalize: strip sha256= prefix if present on either side
        const incomingSig = signature.replace(/^sha256=/, '');
        if (!crypto.timingSafeEqual(Buffer.from(incomingSig), Buffer.from(digest))) {
          return res.status(401).json({ error: 'Invalid webhook signature' });
        }
      }

      // 3. Flatten payload into variables
      const payload = req.body || {};
      const vars = flattenPayload(payload);

      // Extract configured headers as variables
      if (source.headers_to_extract && source.headers_to_extract.length > 0) {
        for (const header of source.headers_to_extract) {
          const val = req.headers[header.toLowerCase()];
          if (val !== undefined) {
            vars[`headers.${header}`] = val;
          }
        }
      }

      // Add source metadata
      vars['source.name'] = source.name;
      vars['source.slug'] = source.slug;
      vars['now'] = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });

      const eventName = vars['event'] || vars['event_type'] || vars['type'] || slug;

      // 4. ALWAYS log the webhook event
      const logEntry = await db.insert('webhook_log', {
        source_id:         source.id,
        event_name:        eventName,
        payload:           JSON.stringify(payload),
        headers:           JSON.stringify(extractRelevantHeaders(req.headers)),
        flattened_vars:    JSON.stringify(vars),
        processing_status: 'received',
      });

      // 5. Process through template engine
      const result = await processWebhookEvent(db, source.id, payload, vars, log);

      // 6. Update webhook log with result
      if (result.matched && result.tasks_created > 0) {
        const firstResult = result.results[0];
        await db.update('webhook_log', {
          matched_template_id: firstResult.template_id,
          created_task_id:     firstResult.task_id,
          processing_status:   'task_created',
        }, 'id = $1', [logEntry.id]);
      } else {
        await db.update('webhook_log', {
          processing_status: 'unmatched',
        }, 'id = $1', [logEntry.id]);
      }

      // 7. Forward if configured (async, don't block response)
      if (source.forward_url) {
        forwardWebhook(source, payload, req.headers, log).catch(err => {
          log.error(`[task-system/webhook] forward to ${source.forward_url} failed: ${err.message}`);
          db.update('webhook_log', {
            processing_status: 'error',
            error_message: `Forward failed: ${err.message}`,
          }, 'id = $1', [logEntry.id]).catch(() => {});
        });
      }

      // 8. Respond
      res.status(200).json({
        received: true,
        event: eventName,
        tasks_created: result.tasks_created,
      });

    } catch (error) {
      log.error(`[task-system/webhook] error processing ${slug}: ${error.message}`);
      res.status(500).json({ error: 'Internal processing error' });
    }
  });

  return router;
}

/**
 * Extract relevant headers (skip noise).
 */
function extractRelevantHeaders(headers) {
  const skip = new Set(['host', 'connection', 'accept-encoding', 'transfer-encoding']);
  const result = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!skip.has(k)) result[k] = v;
  }
  return result;
}

/**
 * Forward webhook payload to configured URL.
 */
async function forwardWebhook(source, payload, originalHeaders, log) {
  const http = require(source.forward_url.startsWith('https') ? 'https' : 'http');
  const url = new URL(source.forward_url);

  const headers = {
    'Content-Type': 'application/json',
    'X-Forwarded-By': 'openclaw-task-system',
  };

  // Copy original signature headers if present
  for (const h of ['x-webhook-signature', 'x-hub-signature-256', 'x-signature']) {
    if (originalHeaders[h]) headers[h] = originalHeaders[h];
  }

  // Merge any configured forward headers
  if (source.forward_headers) {
    const fwdHeaders = typeof source.forward_headers === 'string'
      ? JSON.parse(source.forward_headers)
      : source.forward_headers;
    Object.assign(headers, fwdHeaders);
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        log.info(`[task-system/webhook] forwarded to ${source.forward_url}: ${res.statusCode}`);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Forward timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { createWebhookRouter };

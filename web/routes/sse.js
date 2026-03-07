'use strict';
const { Router } = require('express');

module.exports = function ({ eventBus }) {
  const r = Router();

  r.get('/sse', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });
    res.write(':ok\n\n');

    const handler = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    eventBus.on('event', handler);

    // Keepalive every 30s to prevent proxy timeouts
    const keepalive = setInterval(() => {
      res.write(':ping\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(keepalive);
      eventBus.removeListener('event', handler);
    });
  });

  return r;
};

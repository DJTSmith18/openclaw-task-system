'use strict';
const { Router } = require('express');

module.exports = function ({ db, eventBus }) {
  const r = Router();

  r.get('/tasks/:id/comments', async (req, res) => {
    try {
      const comments = await db.getMany(
        'SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC',
        [req.params.id]
      );
      res.json({ comments });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.post('/tasks/:id/comments', async (req, res) => {
    try {
      const b = req.body;
      if (!b.content) return res.status(400).json({ error: 'content required' });
      const comment = await db.insert('task_comments', {
        task_id: parseInt(req.params.id),
        author: b.author || 'human',
        author_type: b.author_type || 'human',
        content: b.content,
        is_internal: b.is_internal || false,
        attachments: b.attachments ? JSON.stringify(b.attachments) : '[]',
      });
      if (eventBus) eventBus.emit('comment', { action: 'created', id: comment.id });
      res.status(201).json(comment);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.put('/comments/:id', async (req, res) => {
    try {
      const fields = {};
      if (req.body.content !== undefined)     fields.content = req.body.content;
      if (req.body.is_internal !== undefined)  fields.is_internal = req.body.is_internal;
      if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields' });
      const rows = await db.update('task_comments', fields, 'id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
      if (eventBus) eventBus.emit('comment', { action: 'updated', id: rows[0].id });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.delete('/comments/:id', async (req, res) => {
    try {
      const count = await db.delete('task_comments', 'id = $1', [req.params.id]);
      if (eventBus) eventBus.emit('comment', { action: 'deleted', id: parseInt(req.params.id) });
      res.json({ deleted: count });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
};

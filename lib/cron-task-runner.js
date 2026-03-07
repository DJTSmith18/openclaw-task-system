'use strict';

const { matchesCron } = require('./cron-parser');
const { renderTemplate } = require('./webhook-templates');

let _interval = null;
let _db = null;
let _logger = null;
let _eventBus = null;

function buildTemplateVars(tz) {
  const now = new Date();
  const opts = { timeZone: tz };
  const parts = new Intl.DateTimeFormat('en-CA', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const date = `${year}-${month}-${day}`;

  const timeParts = new Intl.DateTimeFormat('en-CA', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const hour = timeParts.find(p => p.type === 'hour').value;
  const minute = timeParts.find(p => p.type === 'minute').value;
  const time = `${hour}:${minute}`;

  const dayLong = now.toLocaleDateString('en-US', { ...opts, weekday: 'long' });
  const dayShort = now.toLocaleDateString('en-US', { ...opts, weekday: 'short' });
  const monthLong = now.toLocaleDateString('en-US', { ...opts, month: 'long' });

  // ISO week number
  const jan1 = new Date(Date.UTC(parseInt(year), 0, 1));
  const dayOfYear = Math.ceil((now - jan1) / 86400000);
  const weekNumber = String(Math.ceil(dayOfYear / 7));

  return {
    date,
    time,
    datetime: `${date} ${time}`,
    day: dayLong,
    day_short: dayShort,
    month: monthLong,
    year,
    week_number: weekNumber,
    timestamp: now.toISOString(),
  };
}

async function tick() {
  if (!_db) return;
  try {
    const templates = await _db.getMany(
      'SELECT * FROM task_templates WHERE enabled = TRUE ORDER BY id'
    );

    const now = new Date();

    for (const tmpl of templates) {
      // Get current time in template's timezone for cron matching
      const tz = tmpl.schedule_tz || 'America/Toronto';
      const localStr = now.toLocaleString('en-US', { timeZone: tz });
      const localDate = new Date(localStr);

      if (!matchesCron(tmpl.schedule_expr, localDate)) continue;

      // Duplicate guard: skip if already ran this minute
      if (tmpl.last_run_at) {
        const lastRun = new Date(tmpl.last_run_at);
        const lastLocal = new Date(lastRun.toLocaleString('en-US', { timeZone: tz }));
        if (
          lastLocal.getFullYear() === localDate.getFullYear() &&
          lastLocal.getMonth() === localDate.getMonth() &&
          lastLocal.getDate() === localDate.getDate() &&
          lastLocal.getHours() === localDate.getHours() &&
          lastLocal.getMinutes() === localDate.getMinutes()
        ) continue;
      }

      // Render template variables
      const vars = buildTemplateVars(tz);
      const title = renderTemplate(tmpl.task_title_template, vars);
      const description = tmpl.task_description_template
        ? renderTemplate(tmpl.task_description_template, vars)
        : null;

      // Create task
      const taskData = {
        title,
        description,
        status: 'todo',
        priority: tmpl.task_priority,
        category: tmpl.task_category || 'general',
        created_by_agent: 'cron-template',
        assigned_to_agent: tmpl.assigned_to_agent || null,
        assigned_at: tmpl.assigned_to_agent ? now.toISOString() : null,
        after_hours_auth: tmpl.after_hours_auth || false,
        tags: Array.isArray(tmpl.tags) ? `{${tmpl.tags.join(',')}}` : tmpl.tags || '{}',
        metadata: JSON.stringify({ task_template_id: tmpl.id }),
      };

      if (tmpl.deadline_offset_minutes) {
        taskData.deadline = new Date(Date.now() + tmpl.deadline_offset_minutes * 60000).toISOString();
      }

      const task = await _db.insert('tasks', taskData);

      // Log work entry
      await _db.insert('work_logs', {
        task_id: task.id,
        agent_id: 'cron-template',
        action: 'status_change',
        status_to: 'todo',
        notes: `Auto-created from task template "${tmpl.name}" (#${tmpl.id})`,
      });

      // Update last_run_at
      await _db.update('task_templates', { last_run_at: now.toISOString() }, 'id = $1', [tmpl.id]);

      // Auto-disable run_once templates
      if (tmpl.run_once) {
        await _db.update('task_templates', { enabled: false }, 'id = $1', [tmpl.id]);
      }

      if (_eventBus) {
        _eventBus.emit('task', { action: 'created', id: task.id });
        _eventBus.emit('cron', { action: 'template_fired', id: tmpl.id });
      }

      _logger.info(`[task-system/cron-template] created task #${task.id} from template "${tmpl.name}"`);
    }
  } catch (err) {
    _logger.error(`[task-system/cron-template] tick error: ${err.message}`);
  }
}

function start(db, logger, eventBus) {
  _db = db;
  _logger = logger || { info: () => {}, error: () => {} };
  _eventBus = eventBus || null;
  _interval = setInterval(tick, 60000);
  _logger.info('[task-system/cron-template] started (60s interval)');
  // Run first tick after short delay to avoid startup race
  setTimeout(tick, 5000);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = { start, stop, tick };

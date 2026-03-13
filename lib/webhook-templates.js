'use strict';

const { minimatch } = require('minimatch');

/**
 * Flatten a nested object into a flat key→value map using dot notation.
 * { event: "a", data: { id: 1 } } → { "event": "a", "data.id": 1 }
 */
function flattenPayload(obj, prefix = '', result = {}) {
  if (obj === null || obj === undefined) return result;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenPayload(value, path, result);
    } else {
      result[path] = value;
    }
  }
  return result;
}

/**
 * Get a nested value from a flat vars map.
 */
function getVar(vars, path) {
  return vars[path];
}

/**
 * Evaluate match rules against flattened variables.
 * ALL rules must match (AND logic).
 * @param {Array} rules - Array of { path, op, value }
 * @param {object} vars - flattened variable map
 * @returns {boolean}
 */
function evaluateMatchRules(rules, vars) {
  if (!rules || !Array.isArray(rules) || rules.length === 0) return true; // empty = match all

  for (const rule of rules) {
    const actual = getVar(vars, rule.path);
    if (!evaluateOp(actual, rule.op, rule.value)) return false;
  }
  return true;
}

/**
 * Evaluate a single operator.
 */
function evaluateOp(actual, op, expected) {
  switch (op) {
    case 'eq':
      return actual == expected; // intentional loose equality for string/number
    case 'neq':
      return actual != expected;
    case 'glob':
      return typeof actual === 'string' && minimatch(actual, String(expected));
    case 'regex':
      try { return typeof actual === 'string' && new RegExp(expected).test(actual); }
      catch { return false; }
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'gt':
      return Number(actual) > Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'exists': {
      // "exists" means "key is present" unless value is explicitly false/"false"/"no"
      const wantExists = expected !== false && expected !== 'false' && expected !== 'no';
      const doesExist = actual !== undefined && actual !== null;
      return wantExists ? doesExist : !doesExist;
    }
    default:
      return false;
  }
}

/**
 * Render a template string with {{variable}} placeholders.
 * Supports:
 *   - {{var}} - simple replacement
 *   - {{var || "fallback"}} - fallback if var is undefined
 *   - {{var ? "yes" : "no"}} - ternary (based on truthiness of var)
 */
function renderTemplate(template, vars) {
  if (!template) return '';

  return template.replace(/\{\{(.+?)\}\}/g, (match, expr) => {
    expr = expr.trim();

    // Ternary: {{var ? "yes" : "no"}}
    const ternaryMatch = expr.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
    if (ternaryMatch) {
      const [, condition, trueVal, falseVal] = ternaryMatch;
      const condValue = resolveValue(condition.trim(), vars);
      const result = condValue ? resolveValue(trueVal.trim(), vars) : resolveValue(falseVal.trim(), vars);
      return stripQuotes(String(result));
    }

    // Fallback: {{var || "default"}}
    const fallbackMatch = expr.match(/^(.+?)\s*\|\|\s*(.+)$/);
    if (fallbackMatch) {
      const [, primary, fallback] = fallbackMatch;
      const val = getVar(vars, primary.trim());
      if (val !== undefined && val !== null && val !== '') return String(val);
      return stripQuotes(resolveValue(fallback.trim(), vars));
    }

    // Simple: {{var}}
    const val = getVar(vars, expr);
    return val !== undefined && val !== null ? String(val) : match;
  });
}

/**
 * Resolve a value: if it's a quoted string return the string, if it's a number return the number,
 * otherwise treat it as a variable path.
 */
function resolveValue(expr, vars) {
  // Quoted string
  if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }
  // Number
  if (/^\d+$/.test(expr)) return Number(expr);
  // Variable
  const val = getVar(vars, expr);
  return val !== undefined ? val : expr;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Process a webhook event: match templates, create tasks.
 * @param {Database} db
 * @param {number} sourceId
 * @param {object} payload - raw webhook payload
 * @param {object} flatVars - pre-flattened variables (or null to auto-flatten)
 * @param {object} logger
 * @returns {object} { matched: boolean, template_id, task_id, tasks_created }
 */
async function processWebhookEvent(db, sourceId, payload, flatVars, logger) {
  const log = logger || { info: () => {}, error: () => {} };
  const vars = flatVars || flattenPayload(payload);

  // Get all enabled templates for this source
  const templates = await db.getMany(
    `SELECT * FROM webhook_templates WHERE source_id = $1 AND enabled = TRUE ORDER BY id`,
    [sourceId]
  );

  const results = [];

  for (const tmpl of templates) {
    const rules = typeof tmpl.match_rules === 'string' ? JSON.parse(tmpl.match_rules) : tmpl.match_rules;
    if (!evaluateMatchRules(rules, vars)) continue;

    // Template matched - create task
    const title = renderTemplate(tmpl.task_title_template, vars);
    const description = renderTemplate(tmpl.task_description_template || '', vars);

    // Debug: log unresolved variables
    const unresolvedTitle = (title.match(/\{\{.+?\}\}/g) || []);
    const unresolvedDesc = (description.match(/\{\{.+?\}\}/g) || []);
    if (unresolvedTitle.length > 0 || unresolvedDesc.length > 0) {
      const varKeys = Object.keys(vars);
      log.error(`[task-system/webhook] UNRESOLVED VARS in template "${tmpl.name}": title=${JSON.stringify(unresolvedTitle)}, desc=${JSON.stringify(unresolvedDesc)}, available_keys=[${varKeys.slice(0, 20).join(', ')}]${varKeys.length > 20 ? ` (+${varKeys.length - 20} more)` : ''}`);
    }
    const priorityStr = renderTemplate(tmpl.task_priority_expr || '3', vars);
    const priority = Math.min(Math.max(parseInt(priorityStr, 10) || 3, 1), 4);
    const externalRefId = tmpl.external_ref_id_expr ? renderTemplate(tmpl.external_ref_id_expr, vars) : null;

    const taskData = {
      title,
      description: description || null,
      status: 'todo',
      priority,
      category: tmpl.task_category || 'general',
      created_by_agent: 'webhook',
      assigned_to_agent: tmpl.assigned_to_agent || null,
      assigned_at: tmpl.assigned_to_agent ? new Date().toISOString() : null,
      external_ref_type: tmpl.external_ref_type || null,
      external_ref_id: externalRefId,
      after_hours_auth: tmpl.after_hours_auth || false,
      tags: tmpl.tags ? (Array.isArray(tmpl.tags) ? `{${tmpl.tags.join(',')}}` : tmpl.tags) : '{}',
      metadata: JSON.stringify({ webhook_source_id: sourceId, webhook_template_id: tmpl.id }),
    };

    // Add deadline if offset configured
    if (tmpl.deadline_offset_minutes) {
      taskData.deadline = new Date(Date.now() + tmpl.deadline_offset_minutes * 60000).toISOString();
    }

    const task = await db.insert('tasks', taskData);

    // Log work entry
    await db.insert('work_logs', {
      task_id: task.id,
      agent_id: 'webhook',
      action: 'status_change',
      status_to: 'todo',
      notes: `Auto-created from webhook source #${sourceId}, template "${tmpl.name}"`,
    });

    results.push({ template_id: tmpl.id, template_name: tmpl.name, task_id: task.id, task_title: title });
    log.info(`[task-system/webhook] created task #${task.id} from template "${tmpl.name}"`);
  }

  return {
    matched: results.length > 0,
    tasks_created: results.length,
    results,
  };
}

module.exports = {
  flattenPayload,
  evaluateMatchRules,
  evaluateOp,
  renderTemplate,
  processWebhookEvent,
  getVar,
};

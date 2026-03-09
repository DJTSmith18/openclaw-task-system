'use strict';

const PRIORITY_LABELS = { 1: 'URGENT', 2: 'High', 3: 'Normal', 4: 'Low' };

/**
 * Render an SMS/notification template with {{placeholder}} variables.
 * @param {string} template
 * @param {object} vars - flat key→value map
 * @returns {string}
 */
function renderMessageTemplate(template, vars) {
  if (!template) return '';
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

/**
 * Format a task for agent wake-up message.
 * @param {object} task
 * @returns {string}
 */
function formatTaskAssignment(task) {
  const parts = [
    `Task Assignment #${task.id}`,
    `Title: ${task.title}`,
    `Priority: ${PRIORITY_LABELS[task.priority] || task.priority}`,
    `Category: ${task.category}`,
  ];
  if (task.deadline) parts.push(`Deadline: ${new Date(task.deadline).toLocaleString('en-US', { timeZone: 'America/Toronto' })}`);
  if (task.description) parts.push(`\nDescription:\n${task.description}`);
  if (task.external_ref_type) parts.push(`\nExternal Ref: ${task.external_ref_type} #${task.external_ref_id}`);
  return parts.join('\n');
}

/**
 * Format escalation notification for SMS.
 * @param {object} task
 * @param {object} escalation
 * @param {string} [smsTemplate] - custom template from escalation rule
 * @returns {string}
 */
function formatEscalationSMS(task, escalation, smsTemplate) {
  if (smsTemplate) {
    return renderMessageTemplate(smsTemplate, {
      task_title: task.title,
      task_id: task.id,
      priority: PRIORITY_LABELS[task.priority] || task.priority,
      agent: task.assigned_to_agent || 'unassigned',
      status: task.status,
      category: task.category,
      deadline: task.deadline || 'none',
      escalation_reason: escalation.trigger_condition,
      timeout: escalation.timeout_minutes || '',
      timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }),
    });
  }

  return [
    'Task System Alert',
    `Task: ${task.title} (#${task.id})`,
    `Priority: ${PRIORITY_LABELS[task.priority] || task.priority}`,
    `Assigned: ${task.assigned_to_agent || 'unassigned'}`,
    `Status: ${task.status}`,
    `Reason: ${escalation.trigger_condition}`,
    `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' })}`,
  ].join('\n');
}

/**
 * Format a status change notification.
 * @param {object} task
 * @param {string} oldStatus
 * @param {string} newStatus
 * @param {string} agentId
 * @returns {string}
 */
function formatStatusChange(task, oldStatus, newStatus, agentId) {
  return `Task #${task.id} "${task.title}" changed from ${oldStatus} to ${newStatus} by ${agentId}`;
}

/**
 * Build a full task transcript for agent context.
 * Includes task header, description, and merged activity log (work logs + comments) in chronological order.
 * @param {object} task - task row
 * @param {Array} workLogs - work_logs rows sorted by created_at ASC
 * @param {Array} [comments] - task_comments rows sorted by created_at ASC
 * @returns {string}
 */
function buildTaskTranscript(task, workLogs, comments = []) {
  const tz = 'America/Toronto';
  const fmt = (ts) => new Date(ts).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

  const lines = [];

  // Header
  lines.push(`TASK #${task.id}: "${task.title}" [${PRIORITY_LABELS[task.priority] || task.priority}] — Status: ${task.status}`);
  const meta = [];
  if (task.category) meta.push(`Category: ${task.category}`);
  if (task.assigned_to_agent) meta.push(`Assigned: ${task.assigned_to_agent}`);
  if (task.deadline) meta.push(`Deadline: ${fmt(task.deadline)}`);
  if (meta.length) lines.push(meta.join(' | '));

  // Description
  if (task.description) {
    lines.push('');
    lines.push('DESCRIPTION:');
    lines.push(task.description);
  }

  // Merge work logs and comments into a single chronological activity log
  const entries = [];
  for (const w of workLogs) {
    let text = `${w.agent_id} — ${w.action}`;
    if (w.status_from) text += `: ${w.status_from} → ${w.status_to}`;
    if (w.time_spent_minutes > 0) text += ` (${w.time_spent_minutes}m)`;
    if (w.notes) text += ` — "${w.notes}"`;
    entries.push({ ts: new Date(w.created_at), text });
  }
  for (const c of comments) {
    const authorType = c.author_type ? ` [${c.author_type}]` : '';
    entries.push({ ts: new Date(c.created_at), text: `${c.author}${authorType} — comment: "${c.content}"` });
  }
  entries.sort((a, b) => a.ts - b.ts);

  if (entries.length > 0) {
    lines.push('');
    lines.push('ACTIVITY LOG (oldest → newest):');
    for (const e of entries) {
      lines.push(`[${fmt(e.ts)}] ${e.text}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  renderMessageTemplate,
  formatTaskAssignment,
  formatEscalationSMS,
  formatStatusChange,
  buildTaskTranscript,
  PRIORITY_LABELS,
};

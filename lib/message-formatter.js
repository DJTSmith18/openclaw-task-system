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

module.exports = {
  renderMessageTemplate,
  formatTaskAssignment,
  formatEscalationSMS,
  formatStatusChange,
  PRIORITY_LABELS,
};

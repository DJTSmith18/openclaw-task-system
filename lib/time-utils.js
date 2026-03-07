'use strict';

/**
 * Check if a given moment is within an agent's working hours.
 * @param {object} agent - agent_availability row
 * @param {Date}   [now] - override current time (for testing)
 * @returns {boolean}
 */
function isWithinWorkingHours(agent, now) {
  if (!agent) return false;
  now = now || new Date();

  // Convert to agent's timezone
  const agentTime = new Date(now.toLocaleString('en-US', { timeZone: agent.timezone || 'America/Toronto' }));
  const day = agentTime.getDay(); // 0=Sun..6=Sat
  const hours = agentTime.getHours();
  const minutes = agentTime.getMinutes();

  // Check working days
  const workingDays = agent.working_days || [1, 2, 3, 4, 5];
  if (!workingDays.includes(day)) return false;

  // Parse working hours
  const [startH, startM] = (agent.working_hours_start || '08:00').split(':').map(Number);
  const [endH, endM] = (agent.working_hours_end || '17:00').split(':').map(Number);

  const currentMinutes = hours * 60 + minutes;
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Check if a task is allowed to be processed right now.
 * @param {object} task  - task row
 * @param {object} agent - agent_availability row
 * @returns {{ allowed: boolean, reason: string }}
 */
function isTaskAllowedNow(task, agent) {
  if (!agent) return { allowed: false, reason: 'Agent not registered' };

  // After-hours authorization overrides time check
  if (task.after_hours_auth) return { allowed: true, reason: 'after_hours_auth' };

  // After-hours capable agents can always work
  if (agent.after_hours_capable) return { allowed: true, reason: 'after_hours_capable' };

  // Check working hours
  if (isWithinWorkingHours(agent)) return { allowed: true, reason: 'within_working_hours' };

  return { allowed: false, reason: 'outside_working_hours' };
}

/**
 * Get the agent's local time string (for display).
 * @param {string} timezone
 * @returns {string}
 */
function getAgentLocalTime(timezone) {
  return new Date().toLocaleString('en-US', {
    timeZone: timezone || 'America/Toronto',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Calculate minutes since a timestamp.
 * @param {string|Date} timestamp
 * @returns {number}
 */
function minutesSince(timestamp) {
  if (!timestamp) return Infinity;
  const diff = Date.now() - new Date(timestamp).getTime();
  return Math.floor(diff / 60000);
}

/**
 * Calculate minutes until a timestamp.
 * @param {string|Date} timestamp
 * @returns {number}
 */
function minutesUntil(timestamp) {
  if (!timestamp) return Infinity;
  const diff = new Date(timestamp).getTime() - Date.now();
  return Math.floor(diff / 60000);
}

module.exports = {
  isWithinWorkingHours,
  isTaskAllowedNow,
  getAgentLocalTime,
  minutesSince,
  minutesUntil,
};

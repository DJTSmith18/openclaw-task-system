'use strict';

// ── Permission groups → tool names ───────────────────────────────────────────
const GROUPS = {
  system:           ['task_system_health', 'task_system_stats'],
  tasks_read:       ['task_query', 'task_summary'],
  tasks_write:      ['task_create', 'task_update', 'task_status', 'task_assign',
                     'task_dependencies', 'task_comment'],
  worklogs_read:    ['worklog_query', 'worklog_time_report'],
  worklogs_write:   ['worklog_add'],
  agents_read:      ['agent_query'],
  agents_write:     ['agent_status_update', 'agent_heartbeat'],
  agents_admin:     ['agent_availability_set'],
  escalation_read:  ['escalation_query'],
  escalation_write: ['escalation_trigger', 'escalation_respond'],
  escalation_admin: ['escalation_rules_manage'],
  webhook_read:     ['webhook_query'],
  webhook_admin:    ['webhook_source_manage', 'webhook_template_manage',
                     'webhook_test', 'webhook_replay'],
  scheduler_read:   ['scheduler_status'],
  scheduler_admin:  ['scheduler_check_stuck', 'scheduler_check_deadlines',
                     'scheduler_run_cycle'],
  cron_read:        ['task_system_cron_query'],
  cron_admin:       ['task_system_cron_manage'],
};

// ── Aliases ─────────────────────────────────────────────────────────────────
const ALL_GROUPS = Object.keys(GROUPS);
const READ_GROUPS = ALL_GROUPS.filter((g) => g.endsWith('_read') || g === 'system');
const WRITE_GROUPS = ALL_GROUPS.filter((g) => g.endsWith('_write') || g.endsWith('_admin'));

const ALIASES = {
  full:          ALL_GROUPS,
  read_all:      READ_GROUPS,
  write_all:     WRITE_GROUPS,
  task_ops:      [
    'system', 'tasks_read', 'tasks_write',
    'worklogs_read', 'worklogs_write',
    'agents_read', 'agents_write',
    'escalation_read', 'escalation_write',
    'webhook_read',
  ],
  task_readonly: [
    'system', 'tasks_read', 'worklogs_read',
    'agents_read', 'escalation_read',
    'scheduler_read', 'webhook_read', 'cron_read',
  ],
  supervisor:    [
    'system', 'tasks_read', 'tasks_write',
    'worklogs_read', 'worklogs_write',
    'agents_read', 'agents_write', 'agents_admin',
    'escalation_read', 'escalation_write', 'escalation_admin',
    'scheduler_read', 'scheduler_admin',
    'cron_read', 'webhook_read', 'webhook_admin',
  ],
};

class PermissionResolver {
  /**
   * @param {object} [agentPermissions] - Config: { agentId: [groupOrAlias...] }
   *   No hardcoded defaults — all agent permissions come from config.
   *   Use '*' key for fallback permissions for any unlisted agent.
   */
  constructor(agentPermissions) {
    this._agentPerms = agentPermissions || {};
  }

  /** Expand aliases and groups into flat Set of tool names for an agent. */
  _resolveToolNames(agentId) {
    const groups = this._agentPerms[agentId] || this._agentPerms['*'] || [];
    const toolNames = new Set();

    for (const entry of groups) {
      // Check if it's an alias first
      const expanded = ALIASES[entry];
      if (expanded) {
        for (const g of expanded) {
          const tools = GROUPS[g];
          if (tools) tools.forEach((t) => toolNames.add(t));
        }
      } else if (GROUPS[entry]) {
        GROUPS[entry].forEach((t) => toolNames.add(t));
      }
      // Unknown entries silently ignored
    }

    return toolNames;
  }

  /** Filter a tools array to only those this agent is allowed to use. */
  filterToolsForAgent(allTools, agentId) {
    const allowed = this._resolveToolNames(agentId);
    return allTools.filter((t) => allowed.has(t.name));
  }

  /** Get the list of group names for an agent (for diagnostics). */
  getAgentGroups(agentId) {
    return this._agentPerms[agentId] || this._agentPerms['*'] || [];
  }

  /** Get the full agent→groups mapping. */
  getAllAgentPermissions() {
    return { ...this._agentPerms };
  }

  /** Set permissions for a single agent. */
  setAgentPermissions(agentId, groups) {
    this._agentPerms[agentId] = groups;
  }

  /** Remove a specific agent's permissions (falls back to '*'). */
  removeAgentPermissions(agentId) {
    delete this._agentPerms[agentId];
  }

  /** Replace the entire agent permissions map. */
  replaceAllPermissions(permsMap) {
    this._agentPerms = { ...permsMap };
  }

  /** Get all known groups and their tool counts. */
  static describeGroups() {
    return Object.entries(GROUPS).map(([name, tools]) => ({
      name,
      tools: tools.length,
      toolNames: tools,
    }));
  }

  /** Get all known aliases and their groups. */
  static describeAliases() {
    return Object.entries(ALIASES).map(([name, groups]) => ({
      name,
      groups,
    }));
  }
}

module.exports = { PermissionResolver, GROUPS, ALIASES };

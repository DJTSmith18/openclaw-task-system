# Task Orchestration System

**OpenClaw Plugin** | v1.0.15 | PostgreSQL + Express + React

Centralized task management, multi-agent coordination, escalation engine, universal webhook-to-task automation, cron-based task templates, smart dispatch with priority preemption, and a full real-time web dashboard.

---

## Features

- **32 agent tools** across 7 groups with per-agent permission control
- **Smart Task Dispatcher** with priority preemption, aging, working hours enforcement
- **Escalation Engine** — 7 trigger types with cooldowns, SMS templates, and agent wake
- **Universal Webhooks** — capture-first design, template engine, 8 match operators
- **Cron Task Templates** — scheduled task creation with 5-field cron expressions
- **Real-time Dashboard** — 10-page React UI with SSE-driven live updates
- **Login gate** with bearer token authentication
- **Eastern time everywhere** (America/Toronto)

---

## Architecture

```
extensions/task-system/
├── index.js                  # Plugin entry point
├── openclaw.plugin.json      # Manifest & config schema
├── package.json
├── lib/
│   ├── tools.js              # 32 agent tool definitions
│   ├── db.js                 # PostgreSQL pool + helpers
│   ├── schema.sql            # 11-table schema
│   ├── migrations/           # Incremental migrations
│   ├── escalation-engine.js  # 7 escalation check types
│   ├── task-dispatcher.js    # Dispatch, preemption, aging
│   ├── scheduler.js          # Periodic cycle runner
│   ├── webhook-listener.js   # Universal webhook receiver
│   ├── webhook-templates.js  # Template rendering engine
│   ├── cron-task-runner.js   # 60s interval task creator
│   ├── cron-parser.js        # 5-field cron matching
│   ├── permissions.js        # 17 groups, 4 aliases
│   ├── event-bus.js          # SSE event emitter
│   ├── message-formatter.js  # Escalation SMS templates
│   └── time-utils.js         # Eastern time helpers
├── web/
│   ├── server.js             # Express server
│   ├── routes/               # 11 route modules
│   └── ui/                   # React 18 + Vite 5
│       └── src/
│           ├── pages/        # 10 pages
│           ├── components/   # Layout, ScheduleBuilder
│           └── hooks/        # useSSE, useApi
├── scripts/
│   ├── install.sh            # Interactive installer
│   ├── migrate.sh            # Run pending migrations
│   └── uninstall.sh          # Clean removal
└── agent-files/              # Scheduler agent identity files
```

---

## Installation

```bash
cd extensions/task-system
bash scripts/install.sh
```

The installer handles:
1. Scheduler agent verification and configuration
2. Prerequisites check (Node.js 18+, PostgreSQL)
3. Database creation and schema setup
4. npm dependencies + UI build
5. Plugin registration in `openclaw.json`
6. Auth token generation
7. Optional systemd service

---

## Configuration

All settings are in `openclaw.json` under `plugins.entries.task-system.config`:

```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "openclaw_tasks",
    "user": "openclaw",
    "password": "..."
  },
  "webUI": {
    "enabled": true,
    "port": 18790,
    "host": "0.0.0.0",
    "authToken": "your-secret-token"
  },
  "scheduler": {
    "agentId": "scheduler",
    "checkIntervalMinutes": 5,
    "stuckThresholdMinutes": 30,
    "deadlineWarningMinutes": 30,
    "cleanupDays": 30,
    "dispatch_cooldown_minutes": 15,
    "priority_aging_minutes": 60,
    "preemption_enabled": true,
    "wake_timeout_seconds": 120
  },
  "agentPermissions": {
    "*": ["system", "tasks_read"],
    "scheduler": ["full"]
  }
}
```

---

## Agent Tools (32)

### Task Management (6)
| Tool | Description |
|------|-------------|
| `task_create` | Create a new task with title, priority, category, deadline, tags, metadata |
| `task_update` | Update task fields (not status) |
| `task_status` | Change task status: todo, in_progress, blocked, done, cancelled |
| `task_assign` | Assign/reassign task (resets status to todo on reassignment) |
| `task_query` | Query tasks: list, get, my_tasks, search |
| `task_dependencies` | Manage dependencies: add, remove, list, check_blocked |

### Task Metadata (2)
| Tool | Description |
|------|-------------|
| `task_comment` | Add comment (human, agent, or system) |
| `task_summary` | Dashboard summary: by status, priority, agent, overdue, unassigned |

### Work Logs (3)
| Tool | Description |
|------|-------------|
| `worklog_add` | Log work with action type, notes, time spent |
| `worklog_query` | Query logs with filters: task, agent, action, date range |
| `worklog_time_report` | Time report grouped by agent, task, category, or date |

### Agent Availability (4)
| Tool | Description |
|------|-------------|
| `agent_status_update` | Update agent status: available, busy, off_duty, observation, maintenance |
| `agent_query` | Query agents: list, get (with active tasks), who_is_available |
| `agent_availability_set` | Configure working hours, max concurrent tasks, capabilities |
| `agent_heartbeat` | Record agent heartbeat |

### Escalation (4)
| Tool | Description |
|------|-------------|
| `escalation_trigger` | Manually escalate task to agent or human |
| `escalation_respond` | Respond: acknowledge, resolve, or take_over |
| `escalation_query` | Query escalation history |
| `escalation_rules_manage` | CRUD for escalation rules |

### Webhooks (5)
| Tool | Description |
|------|-------------|
| `webhook_source_manage` | CRUD for webhook sources (slug-based endpoints) |
| `webhook_template_manage` | CRUD for webhook-to-task templates with match rules |
| `webhook_query` | Query webhook event log |
| `webhook_test` | Dry-run template against sample payload |
| `webhook_replay` | Replay a logged webhook event |

### Scheduler (4)
| Tool | Description |
|------|-------------|
| `scheduler_check_stuck` | Check for tasks stuck in_progress |
| `scheduler_check_deadlines` | Check approaching/missed deadlines |
| `scheduler_run_cycle` | Full cycle: stuck, deadlines, escalations, after-hours, urgent, dispatch |
| `scheduler_status` | Get open tasks, pending escalations, overdue counts |

### System (4)
| Tool | Description |
|------|-------------|
| `task_system_health` | Database health check with pool stats |
| `task_system_stats` | Statistics: completion rate, avg resolution time |
| `task_system_cron_query` | Query OpenClaw cron jobs |
| `task_system_cron_manage` | CRUD for cron jobs |

---

## Database Schema (11 tables)

| Table | Purpose |
|-------|---------|
| `tasks` | Main task table with priority 1-4, status workflow, tags, metadata, parent tasks |
| `work_logs` | Activity log: status changes, notes, time tracking, assignments |
| `agent_availability` | Agent config: working hours, timezone, capabilities, max concurrent |
| `escalation_rules` | Escalation policies with 7 trigger conditions |
| `escalation_history` | Escalation event audit trail |
| `task_dependencies` | Task relationships: blocks, follows, related |
| `task_comments` | Task comments (human/agent/system) |
| `webhook_sources` | Webhook endpoints with HMAC secrets |
| `webhook_templates` | Webhook-to-task mapping with match rules and template vars |
| `webhook_log` | Webhook event audit trail with replay support |
| `task_templates` | Cron-based scheduled task creation |

---

## Smart Task Dispatcher

Runs inside `scheduler_run_cycle` every 5 minutes:

**Priority Aging** — Todo tasks idle beyond `priority_aging_minutes` (default 60) get bumped one level (4→3→2→1).

**Dispatch** — For each agent:
1. Check working hours (skip non-after_hours tasks outside hours)
2. Enforce `dispatch_cooldown_minutes` (default 15)
3. Compute optimal active set from in_progress + ready todo tasks
4. Take top `max_concurrent_tasks` sorted by priority → deadline → created_at
5. **Preempt** lower-priority in_progress tasks if a higher-priority todo exists
6. Wake agent with formatted message listing START/PAUSE/active tasks

---

## Escalation Engine

7 trigger conditions evaluated during scheduler cycles:

| Trigger | Fires When |
|---------|------------|
| `timeout` | Task stuck in_progress beyond threshold |
| `blocked` | Task blocked beyond threshold |
| `after_hours` | Agent working outside configured hours |
| `priority_urgent` | Priority 1 task idle beyond threshold |
| `deadline_approaching` | Deadline within warning window |
| `deadline_missed` | Deadline has passed |
| `permission_required` | Manual trigger |

Each rule supports: cooldown window, max escalations per task, SMS template, priority override, category/agent filters.

When `to_agent` is `"human"`, the scheduler agent is woken with full escalation context to notify a human through available channels.

---

## Webhook System

**Endpoint**: `POST /webhooks/{slug}` (no auth, HMAC-SHA256 per source)

**Capture-first design**: Every event is logged, then matched against templates.

**Match operators**: `eq`, `neq`, `glob`, `regex`, `in`, `gt`, `lt`, `exists` — all rules AND'd together.

**Template syntax**:
```
{{var}}                    — simple substitution
{{var || "fallback"}}      — fallback if empty
{{var ? "yes" : "no"}}     — ternary
```

Unmatched events can be replayed later via `webhook_replay`.

---

## Cron Task Templates

5-field standard cron (`minute hour day month dow`) with timezone-aware scheduling.

**Template variables**: `{{date}}`, `{{time}}`, `{{datetime}}`, `{{day}}`, `{{day_short}}`, `{{month}}`, `{{year}}`, `{{week_number}}`, `{{timestamp}}`

Supports `run_once` mode (auto-disable after first fire) and per-minute duplicate guard.

---

## Permission System

17 permission groups with 4 aliases:

| Alias | Includes |
|-------|----------|
| `full` | All 17 groups |
| `read_all` | All `_read` groups + `system` |
| `write_all` | All `_write` + `_admin` groups |
| `task_ops` | system, tasks, worklogs, agents_read/write, escalation, webhook_read |

Configure per agent in `agentPermissions`. Use `"*"` key for default permissions.

---

## Web Dashboard

10 SSE-driven pages at `http://host:18790/dashboard/`:

| Page | Features |
|------|----------|
| Dashboard | Summary counts by status, priority, agent; overdue/unassigned |
| Tasks | List, filter, search, create, bulk actions |
| Task Detail | Full view, edit, comments, work logs, dependencies |
| Agents | Status, availability, capabilities, task assignment |
| Escalations | Rules management, history, respond to escalations |
| Webhooks | 4 tabs: sources, templates, event log, test |
| Cron Jobs | Merged view of agent-wake jobs + task templates |
| Work Logs | Activity entries, time reports by agent/task/category |
| Settings | Agent permissions, availability, system config |
| Login | Auth gate with bearer token |

---

## Requirements

- Node.js 18+
- PostgreSQL 16
- npm
- jq (for installer)

# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## Task System Tools

Your primary toolset comes from the `task-system` plugin. These are registered automatically when OpenClaw loads.

### Scheduler Tools
- `scheduler_run_cycle` — Full cycle: stuck checks + deadline warnings + cleanup
- `scheduler_check_stuck` — Check only for stuck tasks
- `scheduler_check_deadlines` — Check only for deadline issues
- `scheduler_status` — Get scheduler health and timing info

### Task Tools (Read + Status)
- `task_query` — Query tasks with filters (status, priority, agent, category)
- `task_summary` — Get dashboard-level stats
- `task_status` — Change a task's status (use sparingly, only for automated actions)
- `task_system_health` — System health check
- `task_system_stats` — Completion rates, resolution times

### Escalation Tools
- `escalation_trigger` — Manually fire an escalation
- `escalation_query` — View escalation history and pending items
- `escalation_respond` — Acknowledge or resolve an escalation

### Reporting Tools
- `worklog_add` — Log scheduler actions and findings
- `worklog_time_report` — Generate time reports grouped by agent/task/category
- `agent_query` — List agents, check availability and workload
- `agent_heartbeat` — Send your own heartbeat

## What Goes Here

As you learn the system, add notes about:
- Agent IDs and their typical task categories
- Common escalation patterns you've observed
- Threshold values that work well vs need adjustment
- Time zones of agents (for after-hours detection)
- Any quirks in the system you've discovered

---

Add whatever helps you do your job. This is your cheat sheet.

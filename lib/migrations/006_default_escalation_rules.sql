-- 006_default_escalation_rules.sql
-- Seed default escalation rules so the system works out of the box.
-- Only inserts if the table is empty (won't clobber user-configured rules).

INSERT INTO escalation_rules (name, trigger_condition, to_agent, timeout_minutes, cooldown_minutes, max_escalations)
SELECT * FROM (VALUES
  ('Blocked task escalation',       'blocked',              'human', 30,  30, 10),
  ('Stuck in-progress escalation',  'timeout',              'human', 60,  30, 5),
  ('Deadline approaching warning',  'deadline_approaching', 'human', 60,  60, 3),
  ('Deadline missed escalation',    'deadline_missed',      'human', 0,   30, 5),
  ('Urgent task idle escalation',   'priority_urgent',      'human', 15,  30, 5),
  ('Unacknowledged dispatch',       'unacknowledged',       'human', 10,  30, 3)
) AS defaults(name, trigger_condition, to_agent, timeout_minutes, cooldown_minutes, max_escalations)
WHERE NOT EXISTS (SELECT 1 FROM escalation_rules);

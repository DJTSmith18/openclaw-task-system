-- 004_unacknowledged_trigger.sql
-- Add 'unacknowledged' to escalation_rules trigger_condition CHECK constraint

ALTER TABLE escalation_rules
  DROP CONSTRAINT IF EXISTS escalation_rules_trigger_condition_check;

ALTER TABLE escalation_rules
  ADD CONSTRAINT escalation_rules_trigger_condition_check
  CHECK (trigger_condition IN (
    'timeout', 'blocked', 'after_hours', 'priority_urgent',
    'permission_required', 'deadline_approaching', 'deadline_missed',
    'unacknowledged'
  ));

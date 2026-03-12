-- 009_waiting_status.sql
-- Add 'waiting' to valid task statuses.
-- Used when an agent is waiting for an external response (SMS reply, human answer).
-- Unlike 'blocked', 'waiting' does NOT trigger escalation — it's normal workflow.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo', 'in_progress', 'blocked', 'unblocked', 'waiting', 'done', 'cancelled'));

-- 007_unblocked_status.sql
-- Add 'unblocked' to valid task statuses.
-- When a task transitions from blocked, it goes to 'unblocked' first
-- so the dispatcher can immediately notify the assigned agent.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo', 'in_progress', 'blocked', 'unblocked', 'done', 'cancelled'));

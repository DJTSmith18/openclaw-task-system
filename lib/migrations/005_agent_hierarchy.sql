-- 005_agent_hierarchy.sql
-- Add reports_to column for agent organizational hierarchy

ALTER TABLE agent_availability ADD COLUMN IF NOT EXISTS reports_to TEXT;

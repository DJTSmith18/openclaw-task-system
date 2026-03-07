-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 002: Add task_templates table for scheduled task creation
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS task_templates (
    id                        SERIAL PRIMARY KEY,
    name                      TEXT NOT NULL,
    enabled                   BOOLEAN NOT NULL DEFAULT TRUE,
    run_once                  BOOLEAN NOT NULL DEFAULT FALSE,
    schedule_expr             TEXT NOT NULL,
    schedule_tz               TEXT NOT NULL DEFAULT 'America/Toronto',
    task_title_template       TEXT NOT NULL,
    task_description_template TEXT,
    task_priority             INTEGER NOT NULL DEFAULT 3,
    task_category             TEXT NOT NULL DEFAULT 'general',
    assigned_to_agent         TEXT,
    deadline_offset_minutes   INTEGER,
    tags                      TEXT[] DEFAULT '{}',
    after_hours_auth          BOOLEAN NOT NULL DEFAULT FALSE,
    metadata                  JSONB DEFAULT '{}',
    last_run_at               TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_task_templates_updated_at ON task_templates;
CREATE TRIGGER trg_task_templates_updated_at
    BEFORE UPDATE ON task_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

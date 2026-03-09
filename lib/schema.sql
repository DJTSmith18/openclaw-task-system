-- ═══════════════════════════════════════════════════════════════════════════════
-- OpenClaw Task Orchestration System — Full PostgreSQL Schema
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Utility: auto-update updated_at ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. tasks
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE tasks (
    id                  SERIAL PRIMARY KEY,
    uuid                UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    title               TEXT NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'todo'
                        CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
    priority            INTEGER NOT NULL DEFAULT 3
                        CHECK (priority BETWEEN 1 AND 4),
                        -- 1=urgent, 2=high, 3=normal, 4=low
    category            TEXT NOT NULL DEFAULT 'general',
    created_by_agent    TEXT NOT NULL,
    assigned_to_agent   TEXT,
    assigned_at         TIMESTAMPTZ,
    deadline            TIMESTAMPTZ,
    estimated_minutes   INTEGER,
    actual_minutes      INTEGER DEFAULT 0,
    external_ref_type   TEXT,
    external_ref_id     TEXT,
    after_hours_auth    BOOLEAN NOT NULL DEFAULT FALSE,
    escalation_level    INTEGER NOT NULL DEFAULT 0,
                        -- 0=none, 1=agent, 2=supervisor, 3=human
    parent_task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    tags                TEXT[] DEFAULT '{}',
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to_agent, status);
CREATE INDEX idx_tasks_deadline ON tasks(deadline) WHERE status IN ('todo', 'in_progress');
CREATE INDEX idx_tasks_external ON tasks(external_ref_type, external_ref_id);
CREATE INDEX idx_tasks_priority ON tasks(priority, status);
CREATE INDEX idx_tasks_category ON tasks(category, status);
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_uuid ON tasks(uuid);

CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. work_logs
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE work_logs (
    id                  SERIAL PRIMARY KEY,
    task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id            TEXT NOT NULL,
    action              TEXT NOT NULL DEFAULT 'status_change'
                        CHECK (action IN (
                            'status_change', 'note', 'time_log', 'assignment',
                            'escalation', 'priority_change', 'deadline_change'
                        )),
    status_from         TEXT,
    status_to           TEXT,
    notes               TEXT,
    time_spent_minutes  INTEGER DEFAULT 0,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_logs_task ON work_logs(task_id, created_at DESC);
CREATE INDEX idx_work_logs_agent ON work_logs(agent_id, created_at DESC);
CREATE INDEX idx_work_logs_created ON work_logs(created_at DESC);
CREATE INDEX idx_work_logs_action ON work_logs(action);


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. agent_availability
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE agent_availability (
    agent_id                TEXT PRIMARY KEY,
    display_name            TEXT,
    working_hours_start     TIME NOT NULL DEFAULT '08:00',
    working_hours_end       TIME NOT NULL DEFAULT '17:00',
    working_days            INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}',
                            -- 0=Sun, 1=Mon … 6=Sat
    timezone                TEXT NOT NULL DEFAULT 'America/Toronto',
    after_hours_capable     BOOLEAN NOT NULL DEFAULT FALSE,
    current_status          TEXT NOT NULL DEFAULT 'available'
                            CHECK (current_status IN (
                                'available', 'busy', 'off_duty', 'observation', 'maintenance'
                            )),
    last_heartbeat          TIMESTAMPTZ,
    current_task_id         INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    max_concurrent_tasks    INTEGER NOT NULL DEFAULT 1,
    capabilities            TEXT[] DEFAULT '{}',
    reports_to              TEXT,              -- agent hierarchy: who this agent escalates to
    metadata                JSONB DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_agent_availability_updated_at
    BEFORE UPDATE ON agent_availability
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. escalation_rules
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE escalation_rules (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    trigger_condition   TEXT NOT NULL
                        CHECK (trigger_condition IN (
                            'timeout', 'blocked', 'after_hours', 'priority_urgent',
                            'permission_required', 'deadline_approaching',
                            'deadline_missed', 'unacknowledged'
                        )),
    task_category       TEXT,
    from_agent          TEXT,
    to_agent            TEXT NOT NULL,
    timeout_minutes     INTEGER,
    sms_template        TEXT,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    priority_override   INTEGER,
    cooldown_minutes    INTEGER DEFAULT 30,
    max_escalations     INTEGER DEFAULT 3,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_escalation_rules_enabled ON escalation_rules(enabled)
    WHERE enabled = TRUE;
CREATE INDEX idx_escalation_rules_trigger ON escalation_rules(trigger_condition);


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. task_dependencies
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE task_dependencies (
    task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    dependency_type     TEXT NOT NULL
                        CHECK (dependency_type IN ('blocks', 'follows', 'related')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on_task_id);


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. escalation_history
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE escalation_history (
    id                  SERIAL PRIMARY KEY,
    task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    rule_id             INTEGER REFERENCES escalation_rules(id) ON DELETE SET NULL,
    from_agent          TEXT,
    to_agent            TEXT NOT NULL,
    trigger_condition   TEXT NOT NULL,
    message_sent        TEXT,
    response_received   TEXT,
    response_at         TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'acknowledged', 'resolved', 'expired')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_escalation_history_task ON escalation_history(task_id);
CREATE INDEX idx_escalation_history_status ON escalation_history(status);
CREATE INDEX idx_escalation_history_created ON escalation_history(created_at DESC);


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. task_comments
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE task_comments (
    id                  SERIAL PRIMARY KEY,
    task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author              TEXT NOT NULL,
    author_type         TEXT NOT NULL DEFAULT 'agent'
                        CHECK (author_type IN ('human', 'agent', 'system')),
    content             TEXT NOT NULL,
    is_internal         BOOLEAN NOT NULL DEFAULT FALSE,
    attachments         JSONB DEFAULT '[]',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);

CREATE TRIGGER trg_task_comments_updated_at
    BEFORE UPDATE ON task_comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. webhook_sources
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE webhook_sources (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL UNIQUE,
    description         TEXT,
    secret              TEXT,                       -- HMAC-SHA256 signing key
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    forward_url         TEXT,                       -- optional: forward payload after processing
    forward_headers     JSONB DEFAULT '{}',         -- extra headers for forwarding
    headers_to_extract  TEXT[] DEFAULT '{}',         -- header names to capture as variables
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_sources_slug ON webhook_sources(slug);

CREATE TRIGGER trg_webhook_sources_updated_at
    BEFORE UPDATE ON webhook_sources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. webhook_templates
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE webhook_templates (
    id                      SERIAL PRIMARY KEY,
    source_id               INTEGER NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
    name                    TEXT NOT NULL,
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    match_rules             JSONB NOT NULL DEFAULT '[]',
                            -- Array of: { path, op, value }
                            -- ops: eq, neq, glob, regex, in, gt, lt, exists
                            -- ALL must match (AND logic)
    task_title_template     TEXT NOT NULL,
    task_description_template TEXT,
    task_priority_expr      TEXT DEFAULT '3',
    task_category           TEXT DEFAULT 'general',
    assigned_to_agent       TEXT,
    deadline_offset_minutes INTEGER,
    external_ref_type       TEXT,
    external_ref_id_expr    TEXT,
    tags                    TEXT[] DEFAULT '{}',
    after_hours_auth        BOOLEAN NOT NULL DEFAULT FALSE,
    metadata                JSONB DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_templates_source ON webhook_templates(source_id) WHERE enabled = TRUE;

CREATE TRIGGER trg_webhook_templates_updated_at
    BEFORE UPDATE ON webhook_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- 10. webhook_log
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE webhook_log (
    id                  SERIAL PRIMARY KEY,
    source_id           INTEGER NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
    event_name          TEXT,
    payload             JSONB NOT NULL DEFAULT '{}',
    headers             JSONB DEFAULT '{}',
    flattened_vars      JSONB DEFAULT '{}',
    matched_template_id INTEGER REFERENCES webhook_templates(id) ON DELETE SET NULL,
    created_task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    processing_status   TEXT NOT NULL DEFAULT 'received'
                        CHECK (processing_status IN (
                            'received', 'matched', 'task_created', 'forwarded',
                            'unmatched', 'error'
                        )),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_log_source ON webhook_log(source_id, created_at DESC);
CREATE INDEX idx_webhook_log_status ON webhook_log(processing_status);
CREATE INDEX idx_webhook_log_unmatched ON webhook_log(source_id)
    WHERE processing_status = 'unmatched';
CREATE INDEX idx_webhook_log_created ON webhook_log(created_at DESC);


-- ═════════════════════════════════════════════════════════════════════════════
-- 11. task_templates (scheduled task creation)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE task_templates (
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

CREATE TRIGGER trg_task_templates_updated_at
    BEFORE UPDATE ON task_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- Schema version tracking
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE schema_version (
    version     INTEGER NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT
);

INSERT INTO schema_version (version, description)
VALUES (1, 'Initial schema — 10 tables'),
       (2, '002_task_templates.sql'),
       (3, '003_escalation_updates.sql — remove consecutive_errors trigger');

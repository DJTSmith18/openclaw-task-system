-- Memory system tables: observations, long-term memory, dream log

CREATE TABLE IF NOT EXISTS observations (
    id              SERIAL PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('session_digest','sensor_sweep','insight','manual','consolidation','rumination')),
    content         TEXT NOT NULL,
    obs_type        TEXT NOT NULL DEFAULT 'context'
                    CHECK (obs_type IN ('decision','preference','rule','goal','habit','fact','event','context')),
    importance      NUMERIC(4,2) NOT NULL DEFAULT 5.00
                    CHECK (importance BETWEEN 0.00 AND 10.00),
    tags            TEXT[] DEFAULT '{}',
    metadata        JSONB DEFAULT '{}',
    archived_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obs_agent ON observations(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_active ON observations(created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_long_term (
    id                      SERIAL PRIMARY KEY,
    agent_id                TEXT NOT NULL,
    category                TEXT NOT NULL DEFAULT 'pattern'
                            CHECK (category IN ('pattern','preference','fact','procedure','rule','habit','goal')),
    content                 TEXT NOT NULL,
    confidence              TEXT NOT NULL DEFAULT 'low'
                            CHECK (confidence IN ('low','medium','high')),
    source_observation_ids  INTEGER[] DEFAULT '{}',
    metadata                JSONB DEFAULT '{}',
    superseded_by           INTEGER REFERENCES memory_long_term(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mem_lt_agent ON memory_long_term(agent_id) WHERE superseded_by IS NULL;

CREATE TRIGGER trg_memory_lt_updated_at
    BEFORE UPDATE ON memory_long_term
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS dream_log (
    id                  SERIAL PRIMARY KEY,
    agent_id            TEXT NOT NULL,
    cycle_type          TEXT NOT NULL CHECK (cycle_type IN ('dream','rumination','sensor_sweep')),
    observations_before INTEGER NOT NULL DEFAULT 0,
    observations_after  INTEGER NOT NULL DEFAULT 0,
    archived_count      INTEGER NOT NULL DEFAULT 0,
    decayed_count       INTEGER NOT NULL DEFAULT 0,
    promoted_count      INTEGER NOT NULL DEFAULT 0,
    insights_generated  INTEGER NOT NULL DEFAULT 0,
    duration_ms         INTEGER,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dream_log_agent ON dream_log(agent_id, created_at DESC);

INSERT INTO schema_version (version, description) VALUES (8, '008_memory_system.sql');

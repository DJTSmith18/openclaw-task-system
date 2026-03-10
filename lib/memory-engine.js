'use strict';

// Decay rates per observation type (importance units lost per day)
// Based on total-recall decay model
const DECAY_RATES = {
  event:      0.5,
  fact:       0.1,
  preference: 0.02,
  rule:       0,
  habit:      0,
  goal:       0,
  context:    0.1,
  decision:   0.05,
};

// Archival thresholds: [min_importance, min_age_days]
// importance >= 9.0: never archive
// 7.0-8.9: archive at 7+ days
// 5.0-6.9: archive at 2+ days
// 3.0-4.9: archive at 1+ day
// 0.0-2.9: archive immediately (0 days)
const ARCHIVE_THRESHOLDS = [
  { minImportance: 9.0,  minDays: Infinity },
  { minImportance: 7.0,  minDays: 7 },
  { minImportance: 5.0,  minDays: 2 },
  { minImportance: 3.0,  minDays: 1 },
  { minImportance: 0.0,  minDays: 0 },
];

class MemoryEngine {
  constructor(db, logger) {
    this.db = db;
    this.log = logger || { info: () => {}, error: () => {} };
  }

  // ── Observations CRUD ───────────────────────────────────────────────────────

  async addObservation({ agent_id, source, content, obs_type, importance, tags, metadata, expires_at }) {
    return this.db.insert('observations', {
      agent_id,
      source: source || 'manual',
      content,
      obs_type: obs_type || 'context',
      importance: importance != null ? importance : 5.0,
      tags: tags ? `{${tags.join(',')}}` : '{}',
      metadata: metadata ? JSON.stringify(metadata) : '{}',
      expires_at: expires_at || null,
    });
  }

  async getActiveObservations({ agent_id, limit, min_importance, source, since } = {}) {
    const conditions = ['archived_at IS NULL'];
    const params = [];
    let idx = 1;

    if (agent_id) { conditions.push(`agent_id = $${idx++}`); params.push(agent_id); }
    if (min_importance != null) { conditions.push(`importance >= $${idx++}`); params.push(min_importance); }
    if (source) { conditions.push(`source = $${idx++}`); params.push(source); }
    if (since) { conditions.push(`created_at >= $${idx++}`); params.push(since); }

    const where = conditions.join(' AND ');
    const lim = limit || 100;
    return this.db.getMany(
      `SELECT * FROM observations WHERE ${where} ORDER BY importance DESC, created_at DESC LIMIT ${lim}`,
      params
    );
  }

  async searchObservations({ query, agent_id, tags, limit } = {}) {
    const conditions = ['archived_at IS NULL'];
    const params = [];
    let idx = 1;

    if (agent_id) { conditions.push(`agent_id = $${idx++}`); params.push(agent_id); }
    if (query) { conditions.push(`content ILIKE $${idx++}`); params.push(`%${query}%`); }
    if (tags && tags.length) { conditions.push(`tags && $${idx++}`); params.push(`{${tags.join(',')}}`); }

    const where = conditions.join(' AND ');
    return this.db.getMany(
      `SELECT * FROM observations WHERE ${where} ORDER BY importance DESC, created_at DESC LIMIT ${limit || 50}`,
      params
    );
  }

  async archiveObservation(id, reason) {
    return this.db.update('observations', {
      archived_at: new Date().toISOString(),
      metadata: this.db.raw(`metadata || '${JSON.stringify({ archive_reason: reason })}'::jsonb`),
    }, 'id = $1', [id]);
  }

  async archiveObservationsBatch(ids, reason) {
    if (!ids.length) return 0;
    const { rowCount } = await this.db.query(
      `UPDATE observations SET archived_at = NOW(),
       metadata = metadata || $1::jsonb
       WHERE id = ANY($2) AND archived_at IS NULL`,
      [JSON.stringify({ archive_reason: reason }), ids]
    );
    return rowCount;
  }

  // ── Long-Term Memory ────────────────────────────────────────────────────────

  async promoteToLongTerm({ agent_id, category, content, confidence, source_observation_ids }) {
    return this.db.insert('memory_long_term', {
      agent_id,
      category: category || 'pattern',
      content,
      confidence: confidence || 'low',
      source_observation_ids: source_observation_ids ? `{${source_observation_ids.join(',')}}` : '{}',
    });
  }

  async getLongTermMemory({ agent_id, category } = {}) {
    const conditions = ['superseded_by IS NULL'];
    const params = [];
    let idx = 1;

    if (agent_id) { conditions.push(`agent_id = $${idx++}`); params.push(agent_id); }
    if (category) { conditions.push(`category = $${idx++}`); params.push(category); }

    return this.db.getMany(
      `SELECT * FROM memory_long_term WHERE ${conditions.join(' AND ')} ORDER BY confidence DESC, updated_at DESC`,
      params
    );
  }

  async supersedeLongTerm(oldId, newId) {
    return this.db.update('memory_long_term', { superseded_by: newId }, 'id = $1', [oldId]);
  }

  // ── Programmatic Decay (NO agent needed) ────────────────────────────────────

  async applyDecay(agent_id) {
    let totalDecayed = 0;

    for (const [obsType, rate] of Object.entries(DECAY_RATES)) {
      if (rate <= 0) continue;

      const { rowCount } = await this.db.query(
        `UPDATE observations
         SET importance = GREATEST(0, importance - $1 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0)
         WHERE agent_id = $2
           AND archived_at IS NULL
           AND obs_type = $3
           AND importance > 0`,
        [rate, agent_id, obsType]
      );
      totalDecayed += rowCount;
    }

    return totalDecayed;
  }

  // ── Programmatic Archival (NO agent needed) ──────────────────────────────────

  async archiveByThreshold(agent_id) {
    const archived = [];

    // Archive expired observations
    const { rowCount: expiredCount } = await this.db.query(
      `UPDATE observations SET archived_at = NOW(),
       metadata = metadata || '{"archive_reason":"expired"}'::jsonb
       WHERE agent_id = $1 AND archived_at IS NULL AND expires_at IS NOT NULL AND expires_at < NOW()`,
      [agent_id]
    );
    if (expiredCount) archived.push({ reason: 'expired', count: expiredCount });

    // importance < 3.0: archive immediately
    const { rowCount: lowCount } = await this.db.query(
      `UPDATE observations SET archived_at = NOW(),
       metadata = metadata || '{"archive_reason":"low_importance"}'::jsonb
       WHERE agent_id = $1 AND archived_at IS NULL AND importance < 3.0`,
      [agent_id]
    );
    if (lowCount) archived.push({ reason: 'low_importance (<3.0)', count: lowCount });

    // importance 3.0-4.99: archive at 1+ day
    const { rowCount: band1 } = await this.db.query(
      `UPDATE observations SET archived_at = NOW(),
       metadata = metadata || '{"archive_reason":"aged_1d"}'::jsonb
       WHERE agent_id = $1 AND archived_at IS NULL
         AND importance >= 3.0 AND importance < 5.0
         AND created_at < NOW() - INTERVAL '1 day'`,
      [agent_id]
    );
    if (band1) archived.push({ reason: 'aged_1d (importance 3.0-4.9)', count: band1 });

    // importance 5.0-6.99: archive at 2+ days
    const { rowCount: band2 } = await this.db.query(
      `UPDATE observations SET archived_at = NOW(),
       metadata = metadata || '{"archive_reason":"aged_2d"}'::jsonb
       WHERE agent_id = $1 AND archived_at IS NULL
         AND importance >= 5.0 AND importance < 7.0
         AND created_at < NOW() - INTERVAL '2 days'`,
      [agent_id]
    );
    if (band2) archived.push({ reason: 'aged_2d (importance 5.0-6.9)', count: band2 });

    // importance 7.0-8.99: archive at 7+ days
    const { rowCount: band3 } = await this.db.query(
      `UPDATE observations SET archived_at = NOW(),
       metadata = metadata || '{"archive_reason":"aged_7d"}'::jsonb
       WHERE agent_id = $1 AND archived_at IS NULL
         AND importance >= 7.0 AND importance < 9.0
         AND created_at < NOW() - INTERVAL '7 days'`,
      [agent_id]
    );
    if (band3) archived.push({ reason: 'aged_7d (importance 7.0-8.9)', count: band3 });

    // importance >= 9.0: NEVER archived

    return {
      total_archived: archived.reduce((s, a) => s + a.count, 0),
      details: archived,
    };
  }

  // ── Programmatic Pattern Detection (NO agent needed) ─────────────────────────

  async detectPatterns(agent_id, opts = {}) {
    const lookbackDays = opts.lookback_days || 7;
    const minOccurrences = opts.min_occurrences || 3;
    const minUniqueDays = opts.min_unique_days || 3;

    // Find tag combinations that appear repeatedly across multiple days
    const rows = await this.db.getMany(
      `SELECT
         unnest(tags) AS tag,
         COUNT(*) AS occurrences,
         COUNT(DISTINCT DATE(created_at)) AS unique_days,
         array_agg(id ORDER BY created_at DESC) AS observation_ids,
         array_agg(DISTINCT obs_type) AS types
       FROM observations
       WHERE agent_id = $1
         AND archived_at IS NULL
         AND created_at > NOW() - INTERVAL '${lookbackDays} days'
         AND array_length(tags, 1) > 0
       GROUP BY unnest(tags)
       HAVING COUNT(*) >= $2 AND COUNT(DISTINCT DATE(created_at)) >= $3
       ORDER BY COUNT(*) DESC`,
      [agent_id, minOccurrences, minUniqueDays]
    );

    return rows.map(r => {
      let confidence = 'low';
      if (r.occurrences >= 7 && r.unique_days >= 7) confidence = 'high';
      else if (r.occurrences >= 4 && r.unique_days >= 3) confidence = 'medium';

      return {
        theme_tag: r.tag,
        occurrences: parseInt(r.occurrences),
        unique_days: parseInt(r.unique_days),
        confidence,
        source_ids: r.observation_ids.slice(0, 10), // Cap at 10 for display
        types: r.types,
      };
    });
  }

  // ── Context Building ────────────────────────────────────────────────────────

  async buildAgentContext(agent_id, opts = {}) {
    const maxObs = opts.max_observations || 30;
    const maxLT = opts.max_long_term || 20;

    const observations = await this.db.getMany(
      `SELECT * FROM observations
       WHERE agent_id = $1 AND archived_at IS NULL AND importance >= 3.0
       ORDER BY importance DESC, created_at DESC
       LIMIT $2`,
      [agent_id, maxObs]
    );

    const longTerm = await this.db.getMany(
      `SELECT * FROM memory_long_term
       WHERE agent_id = $1 AND superseded_by IS NULL
       ORDER BY confidence DESC, updated_at DESC
       LIMIT $2`,
      [agent_id, maxLT]
    );

    const lines = [];

    if (observations.length) {
      lines.push('=== RECENT OBSERVATIONS ===');
      for (const o of observations) {
        const ts = new Date(o.created_at).toLocaleString('en-US', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const tags = o.tags?.length ? ` [${o.tags.join(', ')}]` : '';
        lines.push(`- [${ts}] (${o.obs_type}, importance=${parseFloat(o.importance).toFixed(1)})${tags}: ${o.content}`);
      }
    }

    if (longTerm.length) {
      lines.push('');
      lines.push('=== LONG-TERM MEMORY ===');
      for (const m of longTerm) {
        lines.push(`- [${m.category}/${m.confidence}] ${m.content}`);
      }
    }

    return lines.join('\n');
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  async getStats(agent_id) {
    const filter = agent_id ? ' WHERE agent_id = $1' : '';
    const activeFilter = agent_id ? ' WHERE agent_id = $1 AND archived_at IS NULL' : ' WHERE archived_at IS NULL';
    const archivedFilter = agent_id ? ' WHERE agent_id = $1 AND archived_at IS NOT NULL' : ' WHERE archived_at IS NOT NULL';
    const params = agent_id ? [agent_id] : [];

    const active = await this.db.getCount(`SELECT COUNT(*) AS count FROM observations${activeFilter}`, params);
    const archived = await this.db.getCount(`SELECT COUNT(*) AS count FROM observations${archivedFilter}`, params);
    const longTerm = await this.db.getCount(
      `SELECT COUNT(*) AS count FROM memory_long_term${agent_id ? ' WHERE agent_id = $1 AND superseded_by IS NULL' : ' WHERE superseded_by IS NULL'}`,
      params
    );
    const lastDream = await this.db.getOne(
      `SELECT * FROM dream_log${agent_id ? ' WHERE agent_id = $1' : ''} ORDER BY created_at DESC LIMIT 1`,
      params
    );

    return {
      active_observations: active,
      archived_observations: archived,
      long_term_entries: longTerm,
      last_cycle: lastDream ? {
        type: lastDream.cycle_type,
        at: lastDream.created_at,
        archived: lastDream.archived_count,
        promoted: lastDream.promoted_count,
        insights: lastDream.insights_generated,
      } : null,
    };
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  async logCycle(agent_id, cycle_type, stats) {
    return this.db.insert('dream_log', {
      agent_id,
      cycle_type,
      observations_before: stats.observations_before || 0,
      observations_after: stats.observations_after || 0,
      archived_count: stats.archived_count || 0,
      decayed_count: stats.decayed_count || 0,
      promoted_count: stats.promoted_count || 0,
      insights_generated: stats.insights_generated || 0,
      duration_ms: stats.duration_ms || null,
      metadata: stats.metadata ? JSON.stringify(stats.metadata) : '{}',
    });
  }

  // ── Agent Memory Config Helpers ─────────────────────────────────────────────

  async getAgentMemoryConfig(agent_id) {
    const agent = await this.db.getOne('SELECT metadata FROM agent_availability WHERE agent_id = $1', [agent_id]);
    return agent?.metadata?.memory || null;
  }

  async getMemoryEnabledAgents() {
    return this.db.getMany(
      `SELECT agent_id, timezone, metadata FROM agent_availability
       WHERE metadata->'memory'->>'enabled' = 'true'
       ORDER BY agent_id`
    );
  }
}

module.exports = { MemoryEngine };

'use strict';

const ok  = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const err = (msg)  => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

function wrap(fn) {
  return async function (_id, params) {
    try { return await fn(params || {}); }
    catch (e) { return err(e.message || String(e)); }
  };
}

/**
 * Build memory system tool definitions.
 * @param {import('./memory-engine').MemoryEngine} mem
 * @param {object} logger
 * @param {import('./event-bus').EventBus} eventBus
 */
function buildMemoryTools(mem, logger, eventBus) {
  const log = logger || { info: () => {}, error: () => {} };
  const emit = (cat, detail) => { if (eventBus) eventBus.emit(cat, detail); };

  return [

    // ── memory_observe ──────────────────────────────────────────────────────
    {
      name: 'memory_observe',
      description: 'Store a new observation in the memory system. Use this to record important facts, decisions, patterns, or events during your work. Rate importance honestly: routine=1-2, useful=5-6, critical=9-10.',
      parameters: {
        type: 'object',
        required: ['agent_id', 'content'],
        properties: {
          agent_id:   { type: 'string', description: 'Your agent ID' },
          content:    { type: 'string', description: 'The observation text' },
          obs_type:   { type: 'string', enum: ['decision', 'preference', 'rule', 'goal', 'habit', 'fact', 'event', 'context', 'pattern'], description: 'Allowed values: decision, preference, rule, goal, habit, fact, event, context, pattern (default: context)' },
          importance: { type: 'number', description: 'Importance 0.0-10.0 (default: 5.0). Be honest — routine items are 1-2, critical items are 9-10.' },
          tags:       { type: 'array', items: { type: 'string' }, description: 'Tags for pattern detection (e.g. ["database", "blocking", "worker-01"])' },
          source:     { type: 'string', enum: ['manual', 'sensor_sweep', 'rumination', 'session_digest'], description: 'Source of observation (default: manual)' },
          expires_at: { type: 'string', description: 'Optional ISO date when this observation expires' },
        },
      },
      execute: wrap(async (p) => {
        if (!p.content?.trim()) return err('content is required');
        const obs = await mem.addObservation({
          agent_id: p.agent_id,
          source: p.source || 'manual',
          content: p.content.trim(),
          obs_type: p.obs_type || 'context',
          importance: p.importance != null ? Math.max(0, Math.min(10, p.importance)) : 5.0,
          tags: p.tags || [],
          expires_at: p.expires_at || null,
        });
        emit('memory', { action: 'observation_added', id: obs.id, agent: p.agent_id });
        return ok({ id: obs.id, message: `Observation stored (importance: ${obs.importance})` });
      }),
    },

    // ── memory_recall ───────────────────────────────────────────────────────
    {
      name: 'memory_recall',
      description: 'Load your memory context: recent observations and long-term memory. Call this at session start to build continuity from previous sessions.',
      parameters: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id:         { type: 'string', description: 'Your agent ID' },
          max_observations: { type: 'number', description: 'Max recent observations to load (default: 30)' },
          max_long_term:    { type: 'number', description: 'Max long-term memory entries (default: 20)' },
          min_importance:   { type: 'number', description: 'Minimum importance threshold (default: 3.0)' },
          search:           { type: 'string', description: 'Optional search term to filter observations' },
          tags:             { type: 'array', items: { type: 'string' }, description: 'Optional tag filter' },
        },
      },
      execute: wrap(async (p) => {
        if (p.search || p.tags) {
          const results = await mem.searchObservations({
            query: p.search,
            agent_id: p.agent_id,
            tags: p.tags,
            limit: p.max_observations || 30,
          });
          return ok({ observations: results, search: p.search, tags: p.tags });
        }

        const context = await mem.buildAgentContext(p.agent_id, {
          max_observations: p.max_observations || 30,
          max_long_term: p.max_long_term || 20,
        });

        const stats = await mem.getStats(p.agent_id);
        return ok({ context, stats });
      }),
    },

    // ── memory_promote ──────────────────────────────────────────────────────
    {
      name: 'memory_promote',
      description: 'Promote an observation pattern to long-term memory. Used during dream cycle consolidation to save confirmed patterns, preferences, facts, or procedures.',
      parameters: {
        type: 'object',
        required: ['agent_id', 'content', 'category'],
        properties: {
          agent_id:             { type: 'string', description: 'Agent ID this memory belongs to' },
          category:             { type: 'string', enum: ['pattern', 'preference', 'fact', 'procedure', 'rule', 'habit', 'goal'], description: 'Memory category' },
          content:              { type: 'string', description: 'The long-term memory content' },
          confidence:           { type: 'string', enum: ['low', 'medium', 'high'], description: 'Confidence level (default: low)' },
          source_observation_ids: { type: 'array', items: { type: 'number' }, description: 'IDs of source observations that support this pattern' },
        },
      },
      execute: wrap(async (p) => {
        if (!p.content?.trim()) return err('content is required');
        const entry = await mem.promoteToLongTerm({
          agent_id: p.agent_id,
          category: p.category,
          content: p.content.trim(),
          confidence: p.confidence || 'low',
          source_observation_ids: p.source_observation_ids || [],
        });
        emit('memory', { action: 'promoted', id: entry.id, agent: p.agent_id });
        return ok({ id: entry.id, message: `Promoted to long-term memory (${p.category}/${p.confidence || 'low'})` });
      }),
    },

    // ── memory_consolidate ──────────────────────────────────────────────────
    {
      name: 'memory_consolidate',
      description: 'Run programmatic memory consolidation: apply decay, archive stale observations, detect recurring patterns. Returns pattern candidates for your review — only promote patterns you judge to be real and actionable.',
      parameters: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'Agent ID to consolidate' },
        },
      },
      execute: wrap(async (p) => {
        const startTime = Date.now();

        // Get before-count
        const beforeObs = await mem.getActiveObservations({ agent_id: p.agent_id, limit: 10000 });
        const beforeCount = beforeObs.length;

        // Get agent-specific config for pattern detection thresholds
        const memCfg = await mem.getAgentMemoryConfig(p.agent_id);
        const dreamCfg = memCfg?.dream || {};

        // Phase 1: Apply decay
        const decayedCount = dreamCfg.decay_enabled !== false
          ? await mem.applyDecay(p.agent_id) : 0;

        // Phase 2: Archive by threshold
        const archiveResult = dreamCfg.archive_enabled !== false
          ? await mem.archiveByThreshold(p.agent_id) : { total_archived: 0, details: [] };

        // Phase 3: Detect patterns
        const patterns = await mem.detectPatterns(p.agent_id, {
          lookback_days: dreamCfg.pattern_lookback_days || 7,
          min_occurrences: dreamCfg.pattern_min_occurrences || 3,
          min_unique_days: dreamCfg.pattern_min_unique_days || 3,
        });

        // Get sample content for each pattern candidate
        for (const pattern of patterns) {
          const samples = await mem.getActiveObservations({
            agent_id: p.agent_id,
            limit: 3,
          });
          // Filter to matching IDs
          pattern.sample_content = beforeObs
            .filter(o => pattern.source_ids.includes(o.id))
            .slice(0, 3)
            .map(o => o.content);
        }

        // Get after-count
        const afterObs = await mem.getActiveObservations({ agent_id: p.agent_id, limit: 10000 });
        const afterCount = afterObs.length;

        const durationMs = Date.now() - startTime;

        // Log the cycle
        await mem.logCycle(p.agent_id, 'dream', {
          observations_before: beforeCount,
          observations_after: afterCount,
          archived_count: archiveResult.total_archived,
          decayed_count: decayedCount,
          duration_ms: durationMs,
        });

        emit('memory', { action: 'consolidated', agent: p.agent_id });

        return ok({
          observations_before: beforeCount,
          observations_after: afterCount,
          decay_applied: decayedCount,
          archived: archiveResult,
          pattern_candidates: patterns,
          duration_ms: durationMs,
        });
      }),
    },

    // ── memory_insight ──────────────────────────────────────────────────────
    {
      name: 'memory_insight',
      description: 'Store a rumination insight. Insights are observations generated by the rumination cycle, tagged with a cognitive thread type.',
      parameters: {
        type: 'object',
        required: ['agent_id', 'thread', 'content', 'importance'],
        properties: {
          agent_id:   { type: 'string', description: 'Your agent ID' },
          thread:     { type: 'string', enum: ['observation', 'reasoning', 'memory', 'planning'], description: 'Cognitive thread type' },
          content:    { type: 'string', description: 'The insight text' },
          importance: { type: 'number', description: 'Importance 0.0-10.0' },
          tags:       { type: 'array', items: { type: 'string' }, description: 'Tags for this insight' },
        },
      },
      execute: wrap(async (p) => {
        if (!p.content?.trim()) return err('content is required');
        const obs = await mem.addObservation({
          agent_id: p.agent_id,
          source: 'rumination',
          content: p.content.trim(),
          obs_type: p.thread === 'memory' ? 'fact' : (p.thread === 'planning' ? 'goal' : 'context'),
          importance: Math.max(0, Math.min(10, p.importance)),
          tags: [...(p.tags || []), `thread:${p.thread}`],
          metadata: { thread: p.thread },
        });
        emit('memory', { action: 'insight_added', id: obs.id, agent: p.agent_id, thread: p.thread });
        return ok({ id: obs.id, message: `Insight stored (thread: ${p.thread}, importance: ${p.importance})` });
      }),
    },

    // ── memory_status ───────────────────────────────────────────────────────
    {
      name: 'memory_status',
      description: 'Show memory system statistics: active observations, archived count, long-term memory entries, last consolidation cycle.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent ID (omit for all agents)' },
        },
      },
      execute: wrap(async (p) => {
        const stats = await mem.getStats(p.agent_id || null);
        return ok(stats);
      }),
    },

  ];
}

module.exports = { buildMemoryTools };

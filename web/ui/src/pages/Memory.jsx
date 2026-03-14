import React, { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useSort } from '../hooks/useSort';

const OBS_COLUMNS = {
  importance: { key: 'importance', type: 'number' },
  agent: { key: 'agent_id', type: 'string' },
  source: { key: 'source', type: 'string' },
  type: { key: 'obs_type', type: 'string' },
  content: { key: 'content', type: 'string' },
  created: { key: 'created_at', type: 'date' },
};
const DREAM_COLUMNS = {
  agent: { key: 'agent_id', type: 'string' },
  type: { key: 'cycle_type', type: 'string' },
  before: { key: 'observations_before', type: 'number' },
  after: { key: 'observations_after', type: 'number' },
  archived: { key: 'archived_count', type: 'number' },
  decayed: { key: 'decayed_count', type: 'number' },
  promoted: { key: 'promoted_count', type: 'number' },
  insights: { key: 'insights_generated', type: 'number' },
  duration: { key: 'duration_ms', type: 'number' },
  when: { key: 'created_at', type: 'date' },
};

function timeAgo(ts) {
  if (!ts) return '\u2014';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function importanceBadge(imp) {
  const n = parseFloat(imp);
  const cls = n >= 8 ? 'badge-critical' : n >= 5 ? 'badge-in_progress' : 'badge-todo';
  return <span className={`badge ${cls}`} style={{ fontSize: 11 }}>{n.toFixed(1)}</span>;
}

function ObservationsTab({ agentId }) {
  const query = agentId ? `/memory/observations?agent_id=${agentId}&limit=100` : '/memory/observations?limit=100';
  const { data, loading, error, reload } = useApi(query);
  const [expanded, setExpanded] = useState(null);
  const obs = data?.observations || [];
  const { sorted: sortedObs, SortTh } = useSort(obs, OBS_COLUMNS);

  if (loading) return <div className="loading">Loading observations...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <div className="flex-between mb-16">
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{data?.total || 0} active observations</span>
        <button className="btn btn-sm" onClick={reload}>Refresh</button>
      </div>
      <table>
        <thead>
          <tr>
            <SortTh col="importance" style={{ width: 60 }}>Imp.</SortTh>
            <SortTh col="agent" style={{ width: 100 }}>Agent</SortTh>
            <SortTh col="source" style={{ width: 100 }}>Source</SortTh>
            <SortTh col="type" style={{ width: 80 }}>Type</SortTh>
            <SortTh col="content">Content</SortTh>
            <th style={{ width: 80 }}>Tags</th>
            <SortTh col="created" style={{ width: 100 }}>Created</SortTh>
          </tr>
        </thead>
        <tbody>
          {sortedObs.map(o => (
            <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
              <td>{importanceBadge(o.importance)}</td>
              <td style={{ fontSize: 12 }}>{o.agent_id}</td>
              <td style={{ fontSize: 12 }}>{o.source}</td>
              <td style={{ fontSize: 12 }}>{o.obs_type}</td>
              <td style={{ fontSize: 12, maxWidth: 400 }}>
                {expanded === o.id ? o.content : (o.content?.length > 120 ? o.content.slice(0, 120) + '...' : o.content)}
              </td>
              <td style={{ fontSize: 11 }}>{(o.tags || []).map(t => <span key={t} className="tag" style={{ fontSize: 10 }}>{t}</span>)}</td>
              <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(o.created_at)}</td>
            </tr>
          ))}
          {obs.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No active observations</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function LongTermTab({ agentId }) {
  const query = agentId ? `/memory/long-term?agent_id=${agentId}` : '/memory/long-term';
  const { data, loading, error, reload } = useApi(query);

  if (loading) return <div className="loading">Loading long-term memory...</div>;
  if (error) return <div className="error">{error}</div>;

  const entries = data?.entries || [];
  const grouped = {};
  entries.forEach(e => {
    if (!grouped[e.category]) grouped[e.category] = [];
    grouped[e.category].push(e);
  });

  return (
    <div>
      <div className="flex-between mb-16">
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{entries.length} long-term entries</span>
        <button className="btn btn-sm" onClick={reload}>Refresh</button>
      </div>
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} className="card section" style={{ marginBottom: 12 }}>
          <div className="section-title" style={{ textTransform: 'capitalize' }}>{cat} ({items.length})</div>
          {items.map(e => (
            <div key={e.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <div className="flex-between">
                <span>{e.content}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className={`badge ${e.confidence === 'high' ? 'badge-healthy' : e.confidence === 'medium' ? 'badge-in_progress' : 'badge-todo'}`} style={{ fontSize: 10 }}>{e.confidence}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.agent_id}</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Created {timeAgo(e.created_at)}
                {e.source_observation_ids?.length > 0 && ` | From ${e.source_observation_ids.length} observations`}
              </div>
            </div>
          ))}
        </div>
      ))}
      {entries.length === 0 && <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>No long-term memory entries yet</div>}
    </div>
  );
}

function DreamLogTab({ agentId }) {
  const query = agentId ? `/memory/dream-log?agent_id=${agentId}&limit=30` : '/memory/dream-log?limit=30';
  const { data, loading, error, reload } = useApi(query);
  const logs = data?.logs || [];
  const { sorted: sortedLogs, SortTh } = useSort(logs, DREAM_COLUMNS);

  if (loading) return <div className="loading">Loading dream log...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <div className="flex-between mb-16">
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{logs.length} cycle records</span>
        <button className="btn btn-sm" onClick={reload}>Refresh</button>
      </div>
      <table>
        <thead>
          <tr>
            <SortTh col="agent">Agent</SortTh>
            <SortTh col="type">Type</SortTh>
            <SortTh col="before">Before</SortTh>
            <SortTh col="after">After</SortTh>
            <SortTh col="archived">Archived</SortTh>
            <SortTh col="decayed">Decayed</SortTh>
            <SortTh col="promoted">Promoted</SortTh>
            <SortTh col="insights">Insights</SortTh>
            <SortTh col="duration">Duration</SortTh>
            <SortTh col="when">When</SortTh>
          </tr>
        </thead>
        <tbody>
          {sortedLogs.map(l => (
            <tr key={l.id}>
              <td style={{ fontSize: 12 }}>{l.agent_id}</td>
              <td style={{ fontSize: 12 }}>{l.cycle_type}</td>
              <td>{l.observations_before}</td>
              <td>{l.observations_after}</td>
              <td>{l.archived_count}</td>
              <td>{l.decayed_count}</td>
              <td>{l.promoted_count}</td>
              <td>{l.insights_generated}</td>
              <td style={{ fontSize: 12 }}>{l.duration_ms ? `${(l.duration_ms / 1000).toFixed(1)}s` : '\u2014'}</td>
              <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(l.created_at)}</td>
            </tr>
          ))}
          {logs.length === 0 && <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No cycle records yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function StatsPanel({ agentId }) {
  const query = agentId ? `/memory/stats?agent_id=${agentId}` : '/memory/stats';
  const { data, loading } = useApi(query);

  if (loading || !data) return null;

  return (
    <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', marginBottom: 20 }}>
      <div className="card" style={{ textAlign: 'center', padding: 16 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>{data.active_observations}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Active Observations</div>
      </div>
      <div className="card" style={{ textAlign: 'center', padding: 16 }}>
        <div style={{ fontSize: 28, fontWeight: 700 }}>{data.archived_observations}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Archived</div>
      </div>
      <div className="card" style={{ textAlign: 'center', padding: 16 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--success, #50c878)' }}>{data.long_term_entries}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Long-Term Entries</div>
      </div>
      <div className="card" style={{ textAlign: 'center', padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{data.last_cycle ? timeAgo(data.last_cycle.created_at) : 'Never'}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Last Cycle</div>
      </div>
    </div>
  );
}

const TABS = [
  { id: 'observations', label: 'Observations' },
  { id: 'long-term',    label: 'Long-Term Memory' },
  { id: 'dream-log',    label: 'Dream Log' },
];

export default function Memory() {
  const [activeTab, setActiveTab] = useState('observations');
  const [agentId, setAgentId] = useState('');
  const { data: agentsData } = useApi('/agents');
  const agents = agentsData?.agents || [];

  return (
    <div>
      <div className="page-header">
        <h1>Memory</h1>
        <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ minWidth: 180 }}>
          <option value="">All Agents</option>
          {agents.map(a => <option key={a.agent_id} value={a.agent_id}>{a.display_name || a.agent_id}</option>)}
        </select>
      </div>

      <StatsPanel agentId={agentId} />

      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid var(--border)', marginBottom: 20,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 18px', fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-dim)',
              background: 'transparent', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -2, cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'observations' && <ObservationsTab agentId={agentId} />}
      {activeTab === 'long-term' && <LongTermTab agentId={agentId} />}
      {activeTab === 'dream-log' && <DreamLogTab agentId={agentId} />}
    </div>
  );
}

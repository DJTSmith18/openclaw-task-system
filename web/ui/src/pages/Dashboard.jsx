import React from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';

const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
const STATUS_ORDER = ['todo', 'in_progress', 'unblocked', 'blocked', 'waiting', 'done', 'cancelled'];

function StatusCard({ label, count, color }) {
  return (
    <div className="card stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{count}</div>
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Dashboard() {
  const { data, loading, error, reload } = useApi('/dashboard');
  const { connected } = useSSE(reload);

  if (loading) return <div className="loading">Loading dashboard...</div>;
  if (error) return <div className="error">{error}</div>;

  const d = data;
  const statusMap = {};
  (d.tasks?.by_status || []).forEach(r => { statusMap[r.status] = parseInt(r.count); });
  const totalActive = (statusMap.todo || 0) + (statusMap.in_progress || 0) + (statusMap.blocked || 0) + (statusMap.unblocked || 0) + (statusMap.waiting || 0);

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <div className="btn-group">
          <span style={{fontSize:11,color:connected?'var(--green)':'var(--text-muted)',marginRight:8}}>{connected ? 'Live' : 'Connecting...'}</span>
          <button onClick={reload} className="btn btn-sm">Refresh</button>
        </div>
      </div>

      <div className="card-grid">
        <StatusCard label="Active Tasks" count={totalActive} color="var(--accent)" />
        <StatusCard label="In Progress" count={statusMap.in_progress || 0} color="var(--green)" />
        <StatusCard label="Blocked" count={statusMap.blocked || 0} color="var(--red)" />
        <StatusCard label="Waiting" count={statusMap.waiting || 0} color="var(--orange)" />
        <StatusCard label="Overdue" count={d.tasks?.overdue || 0} color="var(--red)" />
        <StatusCard label="Unassigned" count={d.tasks?.unassigned || 0} color="var(--yellow)" />
        <StatusCard label="Escalations" count={d.pending_escalations || 0} color="var(--orange)" />
        <StatusCard label="Completed" count={statusMap.done || 0} color="var(--green)" />
        <StatusCard label="Today (min)" count={d.today_minutes || 0} color="var(--purple)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* By Priority */}
        <div className="card section">
          <div className="section-title">By Priority</div>
          <table>
            <thead><tr><th>Priority</th><th>Count</th></tr></thead>
            <tbody>
              {(d.tasks?.by_priority || []).map(r => (
                <tr key={r.priority}>
                  <td><span className={`priority-${r.priority}`}>{PRIORITY_LABELS[r.priority] || `P${r.priority}`}</span></td>
                  <td>{r.count}</td>
                </tr>
              ))}
              {(!d.tasks?.by_priority?.length) && <tr><td colSpan={2} className="text-center text-dim">No active tasks</td></tr>}
            </tbody>
          </table>
        </div>

        {/* By Agent */}
        <div className="card section">
          <div className="section-title">By Agent</div>
          <table>
            <thead><tr><th>Agent</th><th>Tasks</th></tr></thead>
            <tbody>
              {(d.tasks?.by_agent || []).map(r => (
                <tr key={r.assigned_to_agent}>
                  <td><Link to={`/agents`}>{r.assigned_to_agent}</Link></td>
                  <td>{r.count}</td>
                </tr>
              ))}
              {(!d.tasks?.by_agent?.length) && <tr><td colSpan={2} className="text-center text-dim">No assigned tasks</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Agent Status */}
        <div className="card section">
          <div className="section-title">Agent Status</div>
          <table>
            <thead><tr><th>Agent</th><th>Status</th><th>Last Seen</th></tr></thead>
            <tbody>
              {(d.agents || []).map(a => (
                <tr key={a.agent_id}>
                  <td>{a.display_name || a.agent_id}</td>
                  <td><span className={`badge badge-${a.current_status || 'idle'}`}>{a.current_status || 'idle'}</span></td>
                  <td className="text-dim">{timeAgo(a.last_heartbeat)}</td>
                </tr>
              ))}
              {(!d.agents?.length) && <tr><td colSpan={3} className="text-center text-dim">No agents registered</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Status Breakdown */}
        <div className="card section">
          <div className="section-title">All Statuses</div>
          <table>
            <thead><tr><th>Status</th><th>Count</th></tr></thead>
            <tbody>
              {STATUS_ORDER.map(s => (
                <tr key={s}>
                  <td><span className={`badge badge-${s}`}>{s.replace('_', ' ')}</span></td>
                  <td>{statusMap[s] || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="card section mt-16">
        <div className="section-title">Recent Activity</div>
        <div className="timeline">
          {(d.recent_activity || []).slice(0, 15).map(w => (
            <div key={w.id} className="timeline-item">
              <div className="timeline-dot" />
              <div className="timeline-content">
                <div className="flex-between">
                  <span className="timeline-agent">{w.agent_id}</span>
                  <span className="timeline-time">{timeAgo(w.created_at)}</span>
                </div>
                <div className="timeline-note">
                  <span className="badge" style={{marginRight:6}}>{w.action}</span>
                  {w.task_title && <Link to={`/tasks/${w.task_id}`}>{w.task_title}</Link>}
                  {w.notes && <span style={{color:'var(--text-dim)', marginLeft:8}}>{w.notes}</span>}
                  {w.time_spent_minutes > 0 && <span className="tag" style={{marginLeft:8}}>{w.time_spent_minutes}m</span>}
                </div>
              </div>
            </div>
          ))}
          {(!d.recent_activity?.length) && <div className="empty">No recent activity</div>}
        </div>
      </div>
    </div>
  );
}

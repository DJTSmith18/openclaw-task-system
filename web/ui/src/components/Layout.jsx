import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/',            icon: '⊞', label: 'Dashboard' },
  { to: '/tasks',       icon: '☰', label: 'Tasks' },
  { to: '/agents',      icon: '⊕', label: 'Agents' },
  { to: '/escalations', icon: '⚡', label: 'Escalations' },
  { to: '/webhooks',    icon: '⇄', label: 'Webhooks' },
  { to: '/cron',        icon: '⏱', label: 'Cron Jobs' },
  { to: '/memory',      icon: '◈', label: 'Memory' },
  { to: '/worklogs',    icon: '◷', label: 'Work Logs' },
  { to: '/settings',    icon: '⚙', label: 'Settings' },
];

export default function Layout({ children, onLogout }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="app-layout">
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <span className="logo">{collapsed ? 'OC' : 'OpenClaw Tasks'}</span>
          <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? '▶' : '◀'}
          </button>
        </div>
        <nav>
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <span className="nav-icon">{n.icon}</span>
              {!collapsed && <span className="nav-label">{n.label}</span>}
            </NavLink>
          ))}
        </nav>
        {onLogout && (
          <div style={{ marginTop: 'auto', padding: collapsed ? '12px 8px' : '12px 16px' }}>
            <button className="btn btn-sm" onClick={onLogout} style={{ width: '100%', opacity: 0.7 }}>
              {collapsed ? '↪' : 'Sign Out'}
            </button>
          </div>
        )}
      </aside>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}

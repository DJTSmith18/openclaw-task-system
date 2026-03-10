import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import TaskDetail from './pages/TaskDetail';
import Agents from './pages/Agents';
import Escalations from './pages/Escalations';
import Webhooks from './pages/Webhooks';
import CronJobs from './pages/CronJobs';
import Memory from './pages/Memory';
import WorkLogs from './pages/WorkLogs';
import Settings from './pages/Settings';
import { getToken, clearToken } from './api';

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) { setChecking(false); return; }

    // Verify stored token is still valid
    fetch('/dashboard/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(r => { setAuthed(r.ok); if (!r.ok) clearToken(); })
      .catch(() => { setAuthed(false); clearToken(); })
      .finally(() => setChecking(false));
  }, []);

  function handleLogout() {
    clearToken();
    setAuthed(false);
  }

  if (checking) return null;

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <Layout onLogout={handleLogout}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/escalations" element={<Escalations />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/cron" element={<CronJobs />} />
        <Route path="/memory" element={<Memory />} />
        <Route path="/worklogs" element={<WorkLogs />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

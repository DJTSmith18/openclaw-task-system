import React, { useState } from 'react';
import { setToken } from '../api';

const BASE = '/dashboard/api';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setToken(password);
        onLogin();
      } else {
        setError(data.error || 'Invalid password');
      }
    } catch {
      setError('Unable to connect to server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: 'var(--bg-primary)',
    }}>
      <div className="card" style={{ width: 360, padding: 32 }}>
        <h2 style={{ textAlign: 'center', marginBottom: 8, fontSize: 20 }}>OpenClaw Tasks</h2>
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
          Enter your access token to continue
        </p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Access token"
              autoFocus
              style={{ width: '100%' }}
            />
          </div>
          {error && <div style={{
            color: '#ff6b6b', fontSize: 13, marginBottom: 12,
            padding: '8px 12px', background: 'rgba(255,80,80,0.1)', borderRadius: 6,
          }}>{error}</div>}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading || !password}
            style={{ width: '100%' }}
          >
            {loading ? 'Verifying...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

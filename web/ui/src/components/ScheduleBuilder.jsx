import React, { useState, useEffect } from 'react';

const FREQUENCIES = ['Minutes', 'Hourly', 'Daily', 'Weekly', 'Monthly', 'One Time', 'Custom'];
const MINUTE_OPTIONS = [1, 2, 5, 10, 15, 30];
const HOUR_OPTIONS = [1, 2, 3, 4, 6, 8, 12];
const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseCronToState(expr) {
  if (!expr) return { freq: 'Daily', minute: 0, hour: 9, ampm: 'AM', everyN: 5, hourN: 1, days: [], dayOfMonth: 1, oneTimeMonth: 1, oneTimeDay: 1, custom: '' };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { freq: 'Custom', custom: expr, minute: 0, hour: 9, ampm: 'AM', everyN: 5, hourN: 1, days: [], dayOfMonth: 1, oneTimeMonth: 1, oneTimeDay: 1 };

  const [min, hr, dom, mon, dow] = parts;

  // Minutes: */N * * * *
  if (min.startsWith('*/') && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { freq: 'Minutes', everyN: parseInt(min.slice(2)) || 5, minute: 0, hour: 9, ampm: 'AM', hourN: 1, days: [], dayOfMonth: 1, oneTimeMonth: 1, oneTimeDay: 1, custom: '' };
  }

  // Hourly: N */H * * *
  if (!min.includes('*') && hr.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    return { freq: 'Hourly', hourN: parseInt(hr.slice(2)) || 1, minute: parseInt(min) || 0, hour: 9, ampm: 'AM', everyN: 5, days: [], dayOfMonth: 1, oneTimeMonth: 1, oneTimeDay: 1, custom: '' };
  }

  // Parse hour/minute for time-based schedules
  const h = parseInt(hr) || 0;
  const m = parseInt(min) || 0;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;

  // Weekly: M H * * D,D
  if (dom === '*' && mon === '*' && dow !== '*') {
    const selectedDays = dow.split(',').map(Number);
    return { freq: 'Weekly', days: selectedDays, minute: m, hour: h12, ampm, everyN: 5, hourN: 1, dayOfMonth: 1, oneTimeMonth: 1, oneTimeDay: 1, custom: '' };
  }

  // Monthly: M H D * *
  if (dom !== '*' && mon === '*' && dow === '*') {
    return { freq: 'Monthly', dayOfMonth: parseInt(dom) || 1, minute: m, hour: h12, ampm, everyN: 5, hourN: 1, days: [], oneTimeMonth: 1, oneTimeDay: 1, custom: '' };
  }

  // One Time: M H D M *
  if (dom !== '*' && mon !== '*' && dow === '*') {
    return { freq: 'One Time', oneTimeMonth: parseInt(mon) || 1, oneTimeDay: parseInt(dom) || 1, minute: m, hour: h12, ampm, everyN: 5, hourN: 1, days: [], dayOfMonth: 1, custom: '' };
  }

  // Daily: M H * * *
  if (dom === '*' && mon === '*' && dow === '*') {
    return { freq: 'Daily', minute: m, hour: h12, ampm, everyN: 5, hourN: 1, days: [], dayOfMonth: 1, oneTimeMonth: 1, oneTimeDay: 1, custom: '' };
  }

  return { freq: 'Custom', custom: expr, minute: 0, hour: 9, ampm: 'AM', everyN: 5, hourN: 1, days: [], dayOfMonth: 1, oneTimeMonth: 1, oneTimeDay: 1 };
}

function stateToCron(s) {
  const h24 = s.ampm === 'PM' ? (s.hour === 12 ? 12 : s.hour + 12) : (s.hour === 12 ? 0 : s.hour);
  switch (s.freq) {
    case 'Minutes': return `*/${s.everyN} * * * *`;
    case 'Hourly': return `${s.minute} */${s.hourN} * * *`;
    case 'Daily': return `${s.minute} ${h24} * * *`;
    case 'Weekly': return `${s.minute} ${h24} * * ${s.days.length ? s.days.sort((a,b) => a-b).join(',') : '*'}`;
    case 'Monthly': return `${s.minute} ${h24} ${s.dayOfMonth} * *`;
    case 'One Time': return `${s.minute} ${h24} ${s.oneTimeDay} ${s.oneTimeMonth} *`;
    case 'Custom': return s.custom || '* * * * *';
    default: return '0 9 * * *';
  }
}

export function describeCron(expr) {
  if (!expr) return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hr, dom, mon, dow] = parts;

  // Minutes
  if (min.startsWith('*/') && hr === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  // Hourly
  if (hr.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const m = parseInt(min) || 0;
    return `Every ${hr.slice(2)} hour${parseInt(hr.slice(2)) > 1 ? 's' : ''} at minute ${m}`;
  }

  const h = parseInt(hr);
  const m = parseInt(min);
  if (isNaN(h) || isNaN(m)) return expr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;

  // Weekly
  if (dom === '*' && mon === '*' && dow !== '*') {
    const dayNames = dow.split(',').map(d => DAYS_OF_WEEK[parseInt(d)] || d);
    return `Every ${dayNames.join(', ')} at ${timeStr}`;
  }
  // Monthly
  if (dom !== '*' && mon === '*' && dow === '*') {
    return `Monthly on day ${dom} at ${timeStr}`;
  }
  // One Time
  if (dom !== '*' && mon !== '*' && dow === '*') {
    return `${MONTHS[parseInt(mon) - 1] || mon} ${dom} at ${timeStr}`;
  }
  // Daily
  if (dom === '*' && mon === '*' && dow === '*') {
    return `Daily at ${timeStr}`;
  }
  // Every minute
  if (min === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every minute';
  }
  return expr;
}

function TimePicker({ hour, minute, ampm, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <select value={hour} onChange={e => onChange({ hour: parseInt(e.target.value), minute, ampm })}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{h}</option>)}
      </select>
      <span>:</span>
      <select value={minute} onChange={e => onChange({ hour, minute: parseInt(e.target.value), ampm })}>
        {Array.from({ length: 60 }, (_, i) => i).map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
      </select>
      <select value={ampm} onChange={e => onChange({ hour, minute, ampm: e.target.value })}>
        <option>AM</option><option>PM</option>
      </select>
    </div>
  );
}

export default function ScheduleBuilder({ value, onChange, runOnce, onRunOnceChange }) {
  const [state, setState] = useState(() => parseCronToState(value));

  // Reverse-parse when value changes externally
  useEffect(() => {
    const current = stateToCron(state);
    if (value && value !== current) {
      setState(parseCronToState(value));
    }
  }, [value]);

  function update(patch) {
    setState(prev => {
      const next = { ...prev, ...patch };
      const expr = stateToCron(next);
      onChange(expr);
      // Auto-set run_once for One Time
      if (patch.freq === 'One Time' && onRunOnceChange) onRunOnceChange(true);
      if (patch.freq && patch.freq !== 'One Time' && onRunOnceChange && runOnce) onRunOnceChange(false);
      return next;
    });
  }

  const cronExpr = stateToCron(state);

  return (
    <div>
      <div className="form-group">
        <label>Frequency</label>
        <select value={state.freq} onChange={e => update({ freq: e.target.value })}>
          {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      {state.freq === 'Minutes' && (
        <div className="form-group">
          <label>Every</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select value={state.everyN} onChange={e => update({ everyN: parseInt(e.target.value) })}>
              {MINUTE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>minutes</span>
          </div>
        </div>
      )}

      {state.freq === 'Hourly' && (
        <div className="form-row">
          <div className="form-group">
            <label>Every</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={state.hourN} onChange={e => update({ hourN: parseInt(e.target.value) })}>
                {HOUR_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span>hour{state.hourN > 1 ? 's' : ''}</span>
            </div>
          </div>
          <div className="form-group">
            <label>At minute</label>
            <select value={state.minute} onChange={e => update({ minute: parseInt(e.target.value) })}>
              {Array.from({ length: 60 }, (_, i) => i).map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
            </select>
          </div>
        </div>
      )}

      {state.freq === 'Daily' && (
        <div className="form-group">
          <label>Time</label>
          <TimePicker hour={state.hour} minute={state.minute} ampm={state.ampm}
            onChange={t => update(t)} />
        </div>
      )}

      {state.freq === 'Weekly' && (
        <>
          <div className="form-group">
            <label>Days</label>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {DAYS_OF_WEEK.map((d, i) => (
                <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', padding: '2px 6px', borderRadius: 4, background: state.days.includes(i) ? 'var(--accent)' : 'var(--bg-secondary)', color: state.days.includes(i) ? '#fff' : 'inherit' }}>
                  <input type="checkbox" checked={state.days.includes(i)} style={{ display: 'none' }}
                    onChange={() => {
                      const next = state.days.includes(i) ? state.days.filter(x => x !== i) : [...state.days, i];
                      update({ days: next });
                    }} />
                  {d}
                </label>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label>Time</label>
            <TimePicker hour={state.hour} minute={state.minute} ampm={state.ampm}
              onChange={t => update(t)} />
          </div>
        </>
      )}

      {state.freq === 'Monthly' && (
        <div className="form-row">
          <div className="form-group">
            <label>Day of month</label>
            <select value={state.dayOfMonth} onChange={e => update({ dayOfMonth: parseInt(e.target.value) })}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Time</label>
            <TimePicker hour={state.hour} minute={state.minute} ampm={state.ampm}
              onChange={t => update(t)} />
          </div>
        </div>
      )}

      {state.freq === 'One Time' && (
        <>
          <div className="form-row">
            <div className="form-group">
              <label>Month</label>
              <select value={state.oneTimeMonth} onChange={e => update({ oneTimeMonth: parseInt(e.target.value) })}>
                {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Day</label>
              <select value={state.oneTimeDay} onChange={e => update({ oneTimeDay: parseInt(e.target.value) })}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Time</label>
            <TimePicker hour={state.hour} minute={state.minute} ampm={state.ampm}
              onChange={t => update(t)} />
          </div>
        </>
      )}

      {state.freq === 'Custom' && (
        <div className="form-group">
          <label>Cron expression</label>
          <input value={state.custom} onChange={e => update({ custom: e.target.value })}
            placeholder="* * * * *" style={{ fontFamily: 'monospace' }} />
        </div>
      )}

      <div style={{ marginTop: 8, padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 4, fontSize: '0.85em', color: 'var(--text-secondary)' }}>
        {describeCron(cronExpr)}
      </div>
    </div>
  );
}

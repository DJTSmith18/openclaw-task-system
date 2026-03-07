import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * SSE hook — subscribes to /api/sse and triggers reload on matching events.
 * @param {Function} reloadFn  — function to call when an event arrives
 * @param {string[]} [categories] — only react to these categories (null = all)
 */
export function useSSE(reloadFn, categories) {
  const [connected, setConnected] = useState(false);
  const fnRef = useRef(reloadFn);
  fnRef.current = reloadFn;

  const catsRef = useRef(categories);
  catsRef.current = categories;

  useEffect(() => {
    const token = localStorage.getItem('openclaw_task_token') || '';
    const url = `/dashboard/api/sse${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const es = new EventSource(url);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        const cats = catsRef.current;
        if (!cats || cats.includes(event.category)) {
          fnRef.current();
        }
      } catch { /* ignore parse errors / pings */ }
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  return { connected };
}

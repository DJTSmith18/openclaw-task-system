import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

export function useApi(path, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get(path)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [path, ...deps]);

  useEffect(() => { reload(); }, [reload]);

  return { data, loading, error, reload };
}

export function useInterval(fn, ms) {
  useEffect(() => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, ms]);
}

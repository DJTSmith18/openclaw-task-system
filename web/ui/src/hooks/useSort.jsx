import { useState, useMemo } from 'react';

/**
 * Reusable sorting hook for table data.
 *
 * @param {Array} items - array of objects to sort
 * @param {object} columns - column definitions: { colKey: { key: 'field', type: 'string'|'number'|'date' }, ... }
 * @param {string} [defaultKey] - initial sort column (empty = no sort)
 * @param {string} [defaultDir] - initial direction: 'asc' or 'desc'
 * @returns {{ sorted, sortKey, sortDir, onSort, SortTh }}
 */
export function useSort(items, columns, defaultKey = '', defaultDir = 'asc') {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  function onSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = useMemo(() => {
    if (!sortKey || !columns[sortKey]) return items;
    const col = columns[sortKey];
    return [...items].sort((a, b) => {
      let va = a[col.key], vb = b[col.key];
      if (va == null) va = '';
      if (vb == null) vb = '';
      let cmp = 0;
      if (col.type === 'number') cmp = Number(va) - Number(vb);
      else if (col.type === 'date') cmp = new Date(va || 0).getTime() - new Date(vb || 0).getTime();
      else cmp = String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [items, sortKey, sortDir, columns]);

  function SortTh({ col, children, ...rest }) {
    const active = sortKey === col;
    return (
      <th onClick={() => onSort(col)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...rest.style }} {...rest}>
        {children} {active ? (sortDir === 'asc' ? '▲' : '▼') : <span style={{ opacity: 0.3 }}>⇅</span>}
      </th>
    );
  }

  return { sorted, sortKey, sortDir, onSort, SortTh };
}

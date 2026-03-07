'use strict';

// Check if a cron expression matches a given date.
// 5-field standard cron: minute hour day month dow
// Supports: *, step (*/N), range (N-M), list (N,M), exact values
function matchesCron(expr, date) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const fields = [
    date.getMinutes(),    // 0-59
    date.getHours(),      // 0-23
    date.getDate(),       // 1-31
    date.getMonth() + 1,  // 1-12
    date.getDay(),        // 0-6 (Sun=0)
  ];

  return parts.every((part, i) => matchField(part, fields[i]));
}

function matchField(field, value) {
  return field.split(',').some(segment => {
    // Step: */N or N-M/S
    const [range, stepStr] = segment.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : null;

    let min, max;
    if (range === '*') {
      min = 0; max = 59;
    } else if (range.includes('-')) {
      const [lo, hi] = range.split('-').map(Number);
      min = lo; max = hi;
    } else {
      // Exact value
      if (step) {
        // e.g. 5/10 means starting at 5, every 10
        min = parseInt(range, 10); max = 59;
      } else {
        return value === parseInt(range, 10);
      }
    }

    if (value < min || value > max) return false;
    if (!step) return true;
    return (value - min) % step === 0;
  });
}

module.exports = { matchesCron };

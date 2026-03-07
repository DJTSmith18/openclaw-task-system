'use strict';

const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // one per browser tab
  }

  /**
   * Emit a typed event on the bus.
   * @param {string} category - task|worklog|comment|agent|escalation|rule|webhook|cron|config
   * @param {object} detail   - { action, id?, summary? }
   */
  emit(category, detail) {
    super.emit('event', {
      category,
      action: detail?.action || 'changed',
      id: detail?.id,
      summary: detail?.summary,
      timestamp: Date.now(),
    });
  }
}

module.exports = { EventBus };

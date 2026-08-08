'use strict';

/**
 * Minimal levelled console logger. Keeps scheduler output readable and lets us
 * silence debug chatter in production via LOG_LEVEL.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const active = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, tag, args) {
  if (LEVELS[level] > active) return;
  const prefix = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${tag ? `(${tag})` : ''}`.trimEnd();
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(prefix, ...args);
}

/** Create a logger bound to a subsystem name, e.g. logger('social-feed'). */
function createLogger(tag) {
  return {
    error: (...a) => emit('error', tag, a),
    warn: (...a) => emit('warn', tag, a),
    info: (...a) => emit('info', tag, a),
    debug: (...a) => emit('debug', tag, a),
  };
}

module.exports = createLogger;
module.exports.createLogger = createLogger;

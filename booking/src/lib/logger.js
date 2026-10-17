'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Minimalny logger JSON (jedna linia = jeden wpis), czytelny w logach Railway.
 * Nigdy nie loguj pełnych numerów telefonów ani kodów OTP – używaj maskPhone().
 */
function createLogger({ level = 'info', base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    if (fields && fields.err instanceof Error) {
      entry.err = { message: fields.err.message, code: fields.err.code, status: fields.err.status };
      if (lvl === 'error') entry.err.stack = fields.err.stack;
    }
    const line = JSON.stringify(entry);
    if (LEVELS[lvl] >= LEVELS.warn) process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger({ level, base: { ...base, ...extra } }),
  };
}

module.exports = { createLogger };

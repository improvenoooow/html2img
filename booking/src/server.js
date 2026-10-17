'use strict';

const { DateTime } = require('luxon');
const { loadConfig, ConfigError } = require('./config');
const { createLogger } = require('./lib/logger');
const { createPool, migrate } = require('./db');
const { buildServices } = require('./container');
const { createApp } = require('./app');
const { MockCalendar } = require('./services/mockCalendar');

const MAINTENANCE_INTERVAL_MS = 60_000;

function seedMockCalendar(calendar, config) {
  // Przykładowe zajęte bloki w trybie demo, żeby było widać blokowanie terminów z kalendarza.
  const base = DateTime.now().setZone(config.booking.timezone).startOf('day');
  for (let d = 1; d <= 14; d += 2) {
    const day = base.plus({ days: d });
    calendar.addBusy(day.set({ hour: 10 }).toJSDate(), day.set({ hour: 12 }).toJSDate(), 'Zajęcia grupowe');
    calendar.addBusy(day.set({ hour: 17 }).toJSDate(), day.set({ hour: 18 }).toJSDate(), 'Prywatne');
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger({ level: config.logLevel, base: { service: 'pilanka-booking' } });
  for (const w of config.warnings) logger.warn('config_warning', { warning: w });

  const pool = createPool(config.database);
  pool.on('error', (err) => logger.error('pg_pool_error', { err }));
  await migrate(pool, logger);

  const services = buildServices({ config, pool, logger });
  if (services.calendar instanceof MockCalendar) {
    seedMockCalendar(services.calendar, config);
    logger.warn('gcal_mock_mode', { msg: 'GCAL_PROVIDER=mock – kalendarz w pamięci, bez Google' });
  }

  const app = createApp({ config, pool, ...services, logger });
  const server = app.listen(config.port, () =>
    logger.info('listening', { port: config.port, env: config.env, sms: services.sms.name, gcal: config.gcal.provider }),
  );

  const maintenance = async () => {
    try {
      await services.bookings.runMaintenance();
    } catch (err) {
      logger.error('maintenance_failed', { err });
    }
  };
  const timer = setInterval(maintenance, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  maintenance();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown', { signal });
    clearInterval(timer);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Błąd startu:', err);
  process.exit(1);
});

'use strict';

// Ręczne uruchomienie migracji: `npm run migrate` (serwer i tak migruje przy starcie).
const { createPool, migrate } = require('./index');
const { createLogger } = require('../lib/logger');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Ustaw DATABASE_URL');
    process.exit(1);
  }
  const pool = createPool({ url: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' });
  try {
    await migrate(pool, createLogger());
    console.log('Migracje zakończone.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

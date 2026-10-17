'use strict';

/**
 * Warstwa dostępu do danych. Każda funkcja przyjmuje `db` (pool lub klient w transakcji).
 * Czas "teraz" jest zawsze przekazywany z aplikacji (wstrzykiwany zegar) – nie używamy now() w SQL,
 * dzięki czemu logika wygasania blokad jest deterministyczna i testowalna.
 */

// Rezerwacja blokuje termin, gdy jest potwierdzona, w trakcie potwierdzania
// lub oczekuje na kod SMS i jej soft lock jeszcze nie wygasł.
const ACTIVE = (nowParam) =>
  `(status IN ('confirmed', 'confirming') OR (status = 'pending' AND lock_expires_at > ${nowParam}))`;

const GLOBAL_HOLD_LOCK_KEY = 728_431_002;
const MAINTENANCE_LOCK_KEY = 728_431_003;

/** Serializuje sekcję krytyczną: limity SMS + przydział terminu (blokada transakcyjna). */
async function lockHoldSection(db) {
  await db.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_HOLD_LOCK_KEY]);
}

async function listActiveInRange(db, from, to, now) {
  const { rows } = await db.query(
    `SELECT slot_start, slot_end FROM bookings
     WHERE slot_start < $2 AND slot_end > $1 AND ${ACTIVE('$3')}`,
    [from, to, now],
  );
  return rows;
}

async function countActiveOverlapping(db, start, end, now, { excludeId = null } = {}) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM bookings
     WHERE slot_start < $2 AND slot_end > $1 AND ${ACTIVE('$3')}
       AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [start, end, now, excludeId],
  );
  return rows[0].n;
}

async function findPendingByPhone(db, phoneHash, now) {
  const { rows } = await db.query(
    `SELECT * FROM bookings
     WHERE phone_hash = $1 AND status = 'pending' AND lock_expires_at > $2
     ORDER BY created_at DESC`,
    [phoneHash, now],
  );
  return rows;
}

async function insertBooking(db, b) {
  await db.query(
    `INSERT INTO bookings (id, slot_start, slot_end, status, first_name, last_name, phone, phone_hash, email,
                           lock_expires_at, otp_hash, otp_expires_at, otp_attempts, consent_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $12, $12)`,
    [
      b.id, b.slotStart, b.slotEnd, b.firstName, b.lastName, b.phone, b.phoneHash, b.email,
      b.lockExpiresAt, b.otpHash, b.otpExpiresAt, b.now,
    ],
  );
}

/** Ponowna wysyłka kodu dla tej samej rezerwacji: nowy kod, reset prób, odświeżenie danych i blokady. */
async function refreshPendingBooking(db, id, b) {
  await db.query(
    `UPDATE bookings SET first_name = $2, last_name = $3, email = $4, otp_hash = $5, otp_expires_at = $6,
            otp_attempts = 0, lock_expires_at = $7, consent_at = $8, updated_at = $8
     WHERE id = $1`,
    [id, b.firstName, b.lastName, b.email, b.otpHash, b.otpExpiresAt, b.lockExpiresAt, b.now],
  );
}

async function cancelBooking(db, id, now) {
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = 'cancelled', otp_hash = NULL, updated_at = $2
     WHERE id = $1 AND status = 'pending'`,
    [id, now],
  );
  return rowCount > 0;
}

async function getBooking(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM bookings WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] || null;
}

async function incrementOtpAttempts(db, id, now) {
  const { rows } = await db.query(
    `UPDATE bookings SET otp_attempts = otp_attempts + 1, updated_at = $2 WHERE id = $1 RETURNING otp_attempts`,
    [id, now],
  );
  return rows[0].otp_attempts;
}

async function markConfirming(db, id, now) {
  await db.query(`UPDATE bookings SET status = 'confirming', updated_at = $2 WHERE id = $1`, [id, now]);
}

async function revertToPending(db, id, now) {
  await db.query(`UPDATE bookings SET status = 'pending', updated_at = $2 WHERE id = $1 AND status = 'confirming'`, [
    id,
    now,
  ]);
}

async function markConfirmed(db, id, eventId, now) {
  await db.query(
    `UPDATE bookings SET status = 'confirmed', gcal_event_id = $2, confirmed_at = $3, updated_at = $3,
            otp_hash = NULL, otp_expires_at = NULL
     WHERE id = $1`,
    [id, eventId, now],
  );
}

async function markStatus(db, id, status, now) {
  await db.query(`UPDATE bookings SET status = $2, otp_hash = NULL, updated_at = $3 WHERE id = $1`, [id, status, now]);
}

// --- sms_log ---

async function smsStats(db, { phoneHash, ipHash, hourAgo, dayAgo }) {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE phone_hash = $1 AND created_at > $3)::int AS phone_count,
       min(created_at) FILTER (WHERE phone_hash = $1 AND created_at > $3) AS phone_oldest,
       max(created_at) FILTER (WHERE phone_hash = $1) AS phone_last,
       count(*) FILTER (WHERE ip_hash = $2 AND created_at > $3)::int AS ip_count,
       min(created_at) FILTER (WHERE ip_hash = $2 AND created_at > $3) AS ip_oldest,
       count(*) FILTER (WHERE created_at > $4)::int AS global_count
     FROM sms_log WHERE created_at > $4`,
    [phoneHash, ipHash, hourAgo, dayAgo],
  );
  return rows[0];
}

async function insertSmsLog(db, { phoneHash, ipHash, bookingId, now }) {
  const { rows } = await db.query(
    `INSERT INTO sms_log (phone_hash, ip_hash, booking_id, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [phoneHash, ipHash, bookingId, now],
  );
  return rows[0].id;
}

async function deleteSmsLog(db, id) {
  await db.query('DELETE FROM sms_log WHERE id = $1', [id]);
}

// --- konserwacja ---

async function tryMaintenanceLock(client) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MAINTENANCE_LOCK_KEY]);
  return rows[0].ok;
}

async function releaseMaintenanceLock(client) {
  await client.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK_KEY]);
}

async function expireStalePending(db, now) {
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = 'expired', otp_hash = NULL, updated_at = $1
     WHERE status = 'pending' AND lock_expires_at <= $1`,
    [now],
  );
  return rowCount;
}

async function listStuckConfirming(db, olderThan) {
  const { rows } = await db.query(`SELECT * FROM bookings WHERE status = 'confirming' AND updated_at < $1`, [olderThan]);
  return rows;
}

/** RODO: usuwamy dane niepotwierdzonych rezerwacji po 24 h i potwierdzonych po okresie retencji. */
async function purgeOldData(db, { inactiveBefore, confirmedSlotEndBefore, smsLogBefore }) {
  const a = await db.query(
    `DELETE FROM bookings WHERE status IN ('expired', 'cancelled') AND updated_at < $1`,
    [inactiveBefore],
  );
  const b = await db.query(`DELETE FROM bookings WHERE status = 'confirmed' AND slot_end < $1`, [
    confirmedSlotEndBefore,
  ]);
  const c = await db.query('DELETE FROM sms_log WHERE created_at < $1', [smsLogBefore]);
  return { inactive: a.rowCount, confirmed: b.rowCount, smsLog: c.rowCount };
}

module.exports = {
  lockHoldSection,
  listActiveInRange,
  countActiveOverlapping,
  findPendingByPhone,
  insertBooking,
  refreshPendingBooking,
  cancelBooking,
  getBooking,
  incrementOtpAttempts,
  markConfirming,
  revertToPending,
  markConfirmed,
  markStatus,
  smsStats,
  insertSmsLog,
  deleteSmsLog,
  tryMaintenanceLock,
  releaseMaintenanceLock,
  expireStalePending,
  listStuckConfirming,
  purgeOldData,
};

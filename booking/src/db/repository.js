'use strict';

/**
 * Warstwa dostępu do danych. Każda funkcja przyjmuje `db` (pool lub klient w transakcji).
 * Czas "teraz" jest zawsze przekazywany z aplikacji (wstrzykiwany zegar) – nie używamy now() w SQL,
 * dzięki czemu logika wygasania blokad jest deterministyczna i testowalna.
 */

// Rezerwacja blokuje termin, gdy jest w trakcie potwierdzania lub oczekuje na kod SMS (ważny soft lock).
// Potwierdzone liczymy tylko na żądanie: przy zajęciach indywidualnych źródłem prawdy jest Google Calendar
// (nieprzezroczyste wydarzenie blokuje Free/Busy), więc usunięcie wydarzenia od razu zwalnia termin.
const ACTIVE = (nowParam, includeConfirmed) =>
  `(status = 'confirming' ${includeConfirmed ? "OR status = 'confirmed'" : ''} ` +
  `OR (status = 'pending' AND lock_expires_at > ${nowParam}))`;

const GLOBAL_HOLD_LOCK_KEY = 728_431_002;
const MAINTENANCE_LOCK_KEY = 728_431_003;

/** Serializuje sekcję krytyczną: limity SMS + przydział terminu (blokada transakcyjna). */
async function lockHoldSection(db) {
  await db.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_HOLD_LOCK_KEY]);
}

async function listActiveInRange(db, from, to, now, { includeConfirmed = true, excludeId = null } = {}) {
  const { rows } = await db.query(
    `SELECT slot_start, slot_end FROM bookings
     WHERE slot_start < $2 AND slot_end > $1 AND ${ACTIVE('$3', includeConfirmed)}
       AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [from, to, now, excludeId],
  );
  return rows;
}

async function countActiveOverlapping(db, start, end, now, { excludeId = null, includeConfirmed = true } = {}) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM bookings
     WHERE slot_start < $2 AND slot_end > $1 AND ${ACTIVE('$3', includeConfirmed)}
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

/**
 * Nowy kod dla oczekującej rezerwacji: nowy hash, reset prób, przedłużenie blokady.
 * Termin i dane klienta zmieniane tylko, gdy zostaną podane (czyli gdy klient udowodnił, że to jego rezerwacja).
 */
async function refreshPendingBooking(db, id, b) {
  const { rowCount } = await db.query(
    `UPDATE bookings SET otp_hash = $2, otp_expires_at = $3, otp_attempts = 0, lock_expires_at = $4, updated_at = $5,
            slot_start = COALESCE($6, slot_start), slot_end = COALESCE($7, slot_end),
            first_name = COALESCE($8, first_name), last_name = COALESCE($9, last_name),
            email = CASE WHEN $10::boolean THEN $11 ELSE email END,
            consent_at = CASE WHEN $10::boolean THEN $5 ELSE consent_at END
     WHERE id = $1 AND status = 'pending'`,
    [
      id, b.otpHash, b.otpExpiresAt, b.lockExpiresAt, b.now,
      b.slotStart ?? null, b.slotEnd ?? null, b.firstName ?? null, b.lastName ?? null,
      b.firstName !== undefined, b.email ?? null,
    ],
  );
  return rowCount > 0;
}

/** Zmiana terminu lub danych oczekującej rezerwacji bez wysyłania nowego kodu (kod z SMS-a nadal ważny). */
async function updatePendingDetails(db, id, b) {
  const { rowCount } = await db.query(
    `UPDATE bookings SET slot_start = $2, slot_end = $3, first_name = $4, last_name = $5, email = $6,
            consent_at = $7, updated_at = $7
     WHERE id = $1 AND status = 'pending'`,
    [id, b.slotStart, b.slotEnd, b.firstName, b.lastName, b.email, b.now],
  );
  return rowCount > 0;
}

/** Przywraca stan rezerwacji sprzed nieudanej ponownej wysyłki SMS (kod, próby, blokada, termin, dane). */
async function restorePendingBooking(db, snapshot, now) {
  await db.query(
    `UPDATE bookings SET otp_hash = $2, otp_expires_at = $3, otp_attempts = $4, lock_expires_at = $5,
            slot_start = $6, slot_end = $7, first_name = $8, last_name = $9, email = $10, updated_at = $11
     WHERE id = $1 AND status = 'pending'`,
    [
      snapshot.id, snapshot.otp_hash, snapshot.otp_expires_at, snapshot.otp_attempts, snapshot.lock_expires_at,
      snapshot.slot_start, snapshot.slot_end, snapshot.first_name, snapshot.last_name, snapshot.email, now,
    ],
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
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = 'confirmed', gcal_event_id = $2, confirmed_at = $3, updated_at = $3,
            otp_hash = NULL, otp_expires_at = NULL
     WHERE id = $1 AND status = 'confirming'`,
    [id, eventId, now],
  );
  return rowCount > 0;
}

/** Zmiana statusu tylko z oczekiwanego stanu (ochrona przed wyścigiem weryfikacji i zadania okresowego). */
async function markStatus(db, id, status, now, { from }) {
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = $2, otp_hash = NULL, updated_at = $3 WHERE id = $1 AND status = $4`,
    [id, status, now, from],
  );
  return rowCount > 0;
}

/** Przyszłe potwierdzone rezerwacje z wydarzeniem w GCal (do uzgadniania usuniętych wydarzeń). */
async function listUpcomingConfirmed(db, now) {
  const { rows } = await db.query(
    `SELECT id, gcal_event_id, slot_start, slot_end FROM bookings
     WHERE status = 'confirmed' AND slot_end > $1 AND gcal_event_id IS NOT NULL`,
    [now],
  );
  return rows;
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
  updatePendingDetails,
  restorePendingBooking,
  listUpcomingConfirmed,
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

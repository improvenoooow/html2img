'use strict';

/**
 * Migracje są wykonywane po kolei i dokładnie raz (tabela schema_migrations).
 * Nigdy nie edytuj już wdrożonej migracji – dopisz nową.
 */
module.exports = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE bookings (
        id               uuid PRIMARY KEY,
        slot_start       timestamptz NOT NULL,
        slot_end         timestamptz NOT NULL,
        status           text NOT NULL
                         CHECK (status IN ('pending', 'confirming', 'confirmed', 'expired', 'cancelled')),
        first_name       text,
        last_name        text,
        phone            text,
        phone_hash       text NOT NULL,
        email            text,
        lock_expires_at  timestamptz NOT NULL,
        otp_hash         text,
        otp_expires_at   timestamptz,
        otp_attempts     integer NOT NULL DEFAULT 0,
        gcal_event_id    text,
        consent_at       timestamptz,
        created_at       timestamptz NOT NULL,
        updated_at       timestamptz NOT NULL,
        confirmed_at     timestamptz,
        CHECK (slot_end > slot_start)
      );

      -- Aktywne rezerwacje (blokujące termin) wyszukiwane po zakresie czasu.
      CREATE INDEX bookings_active_slot_idx ON bookings (slot_start, slot_end)
        WHERE status IN ('pending', 'confirming', 'confirmed');
      CREATE INDEX bookings_pending_phone_idx ON bookings (phone_hash)
        WHERE status IN ('pending', 'confirming');
      CREATE INDEX bookings_status_updated_idx ON bookings (status, updated_at);

      -- Dziennik wysłanych SMS-ów na potrzeby rate limitingu (telefon i IP tylko jako HMAC).
      CREATE TABLE sms_log (
        id          bigserial PRIMARY KEY,
        phone_hash  text NOT NULL,
        ip_hash     text NOT NULL,
        booking_id  uuid,
        created_at  timestamptz NOT NULL
      );
      CREATE INDEX sms_log_phone_idx ON sms_log (phone_hash, created_at);
      CREATE INDEX sms_log_ip_idx ON sms_log (ip_hash, created_at);
      CREATE INDEX sms_log_created_idx ON sms_log (created_at);
    `,
  },
];

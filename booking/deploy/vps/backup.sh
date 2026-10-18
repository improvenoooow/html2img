#!/usr/bin/env bash
# Kopia zapasowa bazy rezerwacji (pg_dump + gzip) z rotacją.
# Cron (codziennie 3:15):  15 3 * * * /opt/pilanka-booking/booking/deploy/vps/backup.sh >> /var/log/pilanka-backup.log 2>&1
# Odtworzenie:  gunzip -c PLIK.sql.gz | docker compose exec -T db psql -U booking -d booking
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pilanka-booking}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

file="$BACKUP_DIR/booking-$(date +%F-%H%M).sql.gz"
trap 'rm -f "$file.tmp"' EXIT
docker compose exec -T db pg_dump -U booking -d booking --no-owner | gzip > "$file.tmp"
mv "$file.tmp" "$file"
chmod 600 "$file"
find "$BACKUP_DIR" -name 'booking-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%F %T') kopia: $file ($(du -h "$file" | cut -f1))"

#!/usr/bin/env bash
# Aktualizacja do najnowszej wersji z gita: pobranie, przebudowa, restart bez utraty danych.
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only
profile=()
if docker compose --profile caddy ps --services --status running 2>/dev/null | grep -qx caddy; then profile=(--profile caddy); fi
docker compose "${profile[@]}" up -d --build
docker image prune -f >/dev/null
sleep 5
docker compose ps

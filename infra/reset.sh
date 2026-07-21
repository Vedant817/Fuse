#!/usr/bin/env bash
# Deterministically reset local Fuse infrastructure for a fresh demo/dev run.
# Drops and recreates the Postgres schema via the migration runner; does not
# touch container images. Safe to re-run at any time.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> Ensuring Postgres is up (infra/docker-compose.yml)..."
docker compose up -d postgres

echo "==> Waiting for Postgres health check..."
for _ in $(seq 1 30); do
  if docker compose ps postgres --format json | grep -q '"Health":"healthy"'; then
    break
  fi
  sleep 1
done

echo "==> Dropping and recreating public schema..."
docker compose exec -T postgres psql -U fuse -d fuse -c \
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

echo "==> Applying migrations..."
DATABASE_URL="postgres://fuse:fuse@localhost:5432/fuse" \
  pnpm --dir .. --filter @fuse/breaker-store run migrate

echo "==> Done. Fresh Fuse state store ready at postgres://fuse:fuse@localhost:5432/fuse"

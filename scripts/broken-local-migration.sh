#!/usr/bin/env bash
# #88：在临时目录里对本地 D1 应用一条 migration。
# 默认 SQL 是故意写坏的，用来证明命令非零退出。
# 只使用 --local 和假的 database id，不读取 Cloudflare 凭据，不会连生产库。
set -euo pipefail

db_name="gtd-migrate-fail-demo"
if [[ "$db_name" == "gtd" ]]; then
	echo "refusing production database name" >&2
	exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/migrations" "$tmp/state"

cat >"$tmp/wrangler.json" <<EOF
{
  "name": "gtd-migrate-fail-demo",
  "compatibility_date": "2026-08-18",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "${db_name}",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
}
EOF

sql="${MIGRATION_SQL:-NOT VALID SQL !!!;}"
printf '%s\n' "$sql" >"$tmp/migrations/0001_demo.sql"

cd "$root"
export CI="${CI:-true}"
export WRANGLER_SEND_METRICS="${WRANGLER_SEND_METRICS:-false}"
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_KEY

pnpm exec wrangler d1 migrations apply "$db_name" --local \
	--config "$tmp/wrangler.json" \
	--persist-to "$tmp/state" \
	--cwd "$tmp"

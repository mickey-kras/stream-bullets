#!/usr/bin/env bash
set -Eeuo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is required}"
config=build/server/wrangler.json
current_version() {
  pnpm exec wrangler deployments list --config "$config" --json |
    jq -er 'sort_by(.created_on) | last | .versions | if length == 1 and .[0].percentage == 100 then .[0].version_id else error("A single active version is required for rollback") end'
}

previous_version=$(current_version)
[[ "$previous_version" =~ ^[a-f0-9-]{36}$ ]] || { echo 'Invalid rollback version.' >&2; exit 1; }
headers=$(curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 10 --max-time 30 \
  --header 'Cache-Control: no-cache' --dump-header - --output /dev/null https://streambullets.com/)
if ! grep -Eiq '^X-StreamBullets-Binary-Labels:[[:space:]]*1[[:space:]]*$' <<< "$headers"; then
  echo '::error::Deploy the binary-label compatible reader before applying migrations or deploying this Worker.' >&2
  exit 1
fi
if [[ "$(current_version)" != "$previous_version" ]]; then
  echo '::error::The active Worker changed during compatibility verification. Retry deployment.' >&2
  exit 1
fi

pnpm exec wrangler d1 migrations apply DB --env production --remote

smoke() {
  local page
  page=$(curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 10 --max-time 30 https://streambullets.com/) || return
  grep -Fq 'id="landing-title"' <<< "$page" || return
  curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 10 --max-time 30 https://streambullets.com/fonts.css --output /dev/null
}

rollback() {
  local status=$?
  trap - ERR
  echo '::error::Deployment or smoke check failed. Restoring the previous Worker version.' >&2
  if ! pnpm exec wrangler rollback "$previous_version" --config "$config" --yes --message "Failed smoke $GITHUB_SHA"; then
    echo '::error::Automatic rollback failed. Restore the Worker manually.' >&2
    exit "$status"
  fi
  if ! smoke; then
    echo '::error::Rollback smoke check failed. Check production immediately.' >&2
    exit "$status"
  fi
  echo '::notice::Previous Worker restored. D1 migrations were not reversed.'
  exit "$status"
}

trap rollback ERR
pnpm exec wrangler deploy --config "$config" --message "commit $GITHUB_SHA"
smoke
trap - ERR

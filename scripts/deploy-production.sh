#!/usr/bin/env bash
set -Eeuo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is required}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'GITHUB_SHA must be a full commit SHA.' >&2; exit 1; }
config=build/server/wrangler.json
# Each smoke check reads the page until it comes from the expected Worker version, at most this many times.
smoke_attempts=${SMOKE_ATTEMPTS:-12}
smoke_delay=${SMOKE_DELAY:-5}

current_version() {
  pnpm exec wrangler deployments list --config "$config" --json |
    jq -er 'sort_by(.created_on) | last | .versions | if length == 1 and .[0].percentage == 100 then .[0].version_id else error("A single active version is required for rollback") end'
}

# The commit in the X-StreamBullets-Revision header of a response, or nothing for a version without the header.
# sed exits 0 without a match, so a missing header does not trigger the ERR trap.
revision_of() {
  sed -En 's/^X-StreamBullets-Revision:[[:space:]]*([a-f0-9]{40})[[:space:]]*$/\1/Ip' <<< "$1" | tail -n 1
}

previous_version=$(current_version)
[[ "$previous_version" =~ ^[a-f0-9-]{36}$ ]] || { echo 'Invalid rollback version.' >&2; exit 1; }
headers=$(curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 10 --max-time 30 \
  --header 'Cache-Control: no-cache' --dump-header - --output /dev/null https://streambullets.com/)
if ! grep -Eiq '^X-StreamBullets-Binary-Labels:[[:space:]]*1[[:space:]]*$' <<< "$headers"; then
  echo '::error::Deploy the binary-label compatible reader before applying migrations or deploying this Worker.' >&2
  exit 1
fi
# The revision the previous version serves: empty for a version from before the header.
previous_revision=$(revision_of "$headers")
if [[ "$previous_revision" == "$GITHUB_SHA" ]]; then
  echo '::error::Production already serves this commit, so the smoke check could not tell the versions apart.' >&2
  exit 1
fi
if [[ "$(current_version)" != "$previous_version" ]]; then
  echo '::error::The active Worker changed during compatibility verification. Retry deployment.' >&2
  exit 1
fi

pnpm exec wrangler d1 migrations apply DB --env production --remote

# Both versions serve the landing page, so the content checks count only once the page comes from `expected`.
# Each return has its status: in the ERR trap, a bare `return` would give the status from before the trap.
smoke() {
  local expected=$1 page served attempt
  for ((attempt = 1; attempt <= smoke_attempts; attempt++)); do
    page=$(curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 10 --max-time 30 \
      --header 'Cache-Control: no-cache' --include https://streambullets.com/) || return 1
    served=$(revision_of "$page")
    if [[ "$served" == "$expected" ]]; then
      grep -Fq 'id="landing-title"' <<< "$page" || return 1
      curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 10 --max-time 30 \
        https://streambullets.com/fonts.css --output /dev/null || return 1
      return 0
    fi
    echo "Attempt $attempt: production serves revision ${served:-none}, not ${expected:-none} yet."
    sleep "$smoke_delay"
  done
  echo "::error::Production did not serve revision ${expected:-none} in time." >&2
  return 1
}

rollback() {
  local status=$?
  trap - ERR
  echo '::error::Deployment or smoke check failed. Restoring the previous Worker version.' >&2
  if ! pnpm exec wrangler rollback "$previous_version" --config "$config" --yes --message "Failed smoke $GITHUB_SHA"; then
    echo '::error::Automatic rollback failed. Restore the Worker manually.' >&2
    exit "$status"
  fi
  if ! smoke "$previous_revision"; then
    echo '::error::Rollback smoke check failed. Check production immediately.' >&2
    exit "$status"
  fi
  echo '::notice::Previous Worker restored. D1 migrations were not reversed.'
  exit "$status"
}

trap rollback ERR
pnpm exec wrangler deploy --config "$config" --var "DEPLOYED_COMMIT:$GITHUB_SHA" --message "commit $GITHUB_SHA"
smoke "$GITHUB_SHA"
trap - ERR

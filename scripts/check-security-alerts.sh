#!/usr/bin/env bash
set -euo pipefail

: "${REPO:?REPO is required}"
: "${GITHUB_TOKEN_ALERTS:?GITHUB_TOKEN_ALERTS is required}"
if [ -z "${SECRET_SCAN_TOKEN:-}" ]; then
  echo "::error::SECRET_SCAN_TOKEN is not configured; E18 requires the secret scanning alert count, so publishing is blocked (fail-closed)"
  exit 1
fi

count_open() {
  local label="$1" token="$2" endpoint="$3" out n
  if ! out=$(GH_TOKEN="$token" gh api --paginate "$endpoint" --jq '.[].number' 2>&1); then
    echo "::error::failed to query ${label} alerts, publishing is blocked (fail-closed): ${out}"
    exit 1
  fi
  n=$(printf '%s\n' "$out" | grep -c . || true)
  echo "${label} open alerts: ${n}"
  if [ "${n}" -ne 0 ]; then
    echo "::error::${label} has ${n} open alert(s); publishing is blocked (E18)"
    exit 1
  fi
}

count_open Dependabot "$GITHUB_TOKEN_ALERTS" "repos/${REPO}/dependabot/alerts?state=open&per_page=100"
count_open "Code scanning" "$GITHUB_TOKEN_ALERTS" "repos/${REPO}/code-scanning/alerts?state=open&per_page=100"
count_open "Secret scanning" "$SECRET_SCAN_TOKEN" "repos/${REPO}/secret-scanning/alerts?state=open&per_page=100"

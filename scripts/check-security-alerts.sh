#!/usr/bin/env bash
# E18 hard gate: fail closed unless Dependabot, code scanning and secret scanning
# all report zero open alerts.
#
# Runs in publish.yml after checkout and before anything is built or published.
# Any query failure is treated as "not clean" (fail-closed).
#
# Required environment:
#   REPO                owner/name (${{ github.repository }} in Actions)
#   GITHUB_TOKEN_ALERTS token that may read Dependabot + code scanning alerts
#   SECRET_SCAN_TOKEN   token that may read secret scanning alerts. GITHUB_TOKEN
#                       cannot read them (HTTP 403 "Resource not accessible by
#                       integration"), so this is a read-only fine-grained PAT
#                       stored as the SECURITY_ALERTS_TOKEN environment secret.
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

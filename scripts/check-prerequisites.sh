#!/usr/bin/env bash
# Reports whether the healthcare upload run can start (CSV + API keys).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LEADS="${LEADS_PATH:-data/healthcare_founders_owners_netnew_5000.csv}"
REQUIRED_KEYS=(OPENAI_API_KEY TRYKITT_API_KEY MILLIONVERIFIER_API_KEY PLUSVIBE_KEY SUPABASE_URL SUPABASE_KEY)

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

missing_keys=()
for key in "${REQUIRED_KEYS[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing_keys+=("$key")
  fi
done

echo "=== Healthcare upload prerequisites ==="
echo "CSV path: $LEADS"
if [[ -f "$LEADS" ]]; then
  rows=$(tail -n +2 "$LEADS" | grep -c . || true)
  echo "CSV: OK ($rows data rows)"
else
  echo "CSV: MISSING"
fi

if [[ ${#missing_keys[@]} -eq 0 ]]; then
  echo "API keys: OK (all 6 set via .env or environment)"
else
  echo "API keys: MISSING ${missing_keys[*]}"
fi

if [[ -f "$LEADS" && ${#missing_keys[@]} -eq 0 ]]; then
  echo ""
  echo "Ready to run: npm run run:healthcare"
  exit 0
fi

echo ""
echo "Not ready. For Cloud Agent Option B:"
echo "  1. Share a Google Sheets link, or commit CSV to data/healthcare_founders_owners_netnew_5000.csv"
echo "  2. Add secrets in Cursor Settings → Cloud Agents → Secrets"
exit 1

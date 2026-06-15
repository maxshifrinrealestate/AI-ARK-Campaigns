#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG="configs/welltech_csuite_healthcare.json"
LEADS="${LEADS_PATH:-data/healthcare_founders_owners_netnew_5000.csv}"
PILOT_ONLY="${PILOT_ONLY:-0}"
PILOT_SIZE="${PILOT_SIZE:-25}"

if [[ ! -f "$LEADS" ]]; then
  echo "Leads CSV not found: $LEADS"
  echo "Set LEADS_PATH or copy your file to data/healthcare_founders_owners_netnew_5000.csv"
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

REQUIRED_KEYS=(OPENAI_API_KEY TRYKITT_API_KEY MILLIONVERIFIER_API_KEY PLUSVIBE_KEY SUPABASE_URL SUPABASE_KEY)
missing_keys=()
for key in "${REQUIRED_KEYS[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing_keys+=("$key")
  fi
done
if [[ ${#missing_keys[@]} -gt 0 ]]; then
  echo "Missing API keys: ${missing_keys[*]}"
  echo "Add them in Cursor Dashboard → Cloud Agents → Secrets, or copy .env.example to .env"
  exit 1
fi

echo "=== Step 1: Validate CSV ==="
npx tsx scripts/validate-leads-csv.ts --leads "$LEADS"

echo ""
echo "=== Step 2: Pilot run (first $PILOT_SIZE rows) ==="
npm start -- --config "$CONFIG" --leads "$LEADS" --pilot "$PILOT_SIZE"

PILOT_OUT="$(ls -dt run_outputs_* 2>/dev/null | head -1 || true)"
if [[ -n "$PILOT_OUT" ]]; then
  echo ""
  echo "Pilot artifacts: $PILOT_OUT"
  for f in enriched_leads.csv removed_leads.csv upload_errors.csv run_summary.json; do
    if [[ -f "$PILOT_OUT/$f" ]]; then
      echo "  - $PILOT_OUT/$f"
    fi
  done
fi

if [[ "$PILOT_ONLY" == "1" ]]; then
  echo "PILOT_ONLY=1 — skipping full run."
  exit 0
fi

echo ""
echo "=== Step 3: Full run ==="
npm start -- --config "$CONFIG" --leads "$LEADS"

FULL_OUT="$(ls -dt run_outputs_* 2>/dev/null | head -1 || true)"
if [[ -n "$FULL_OUT" && -f "$FULL_OUT/run_summary.json" ]]; then
  mkdir -p outputs/archive
  cp "$FULL_OUT/run_summary.json" "outputs/archive/run_summary_$(basename "$FULL_OUT").json"
  echo "Archived run summary to outputs/archive/run_summary_$(basename "$FULL_OUT").json"
fi

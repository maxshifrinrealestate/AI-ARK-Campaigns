#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG="configs/welltech_csuite_healthcare.json"
LEADS="${LEADS_PATH:-data/csuite_healthcare_jun04.csv}"
PILOT_ONLY="${PILOT_ONLY:-0}"
PILOT_SIZE="${PILOT_SIZE:-25}"

if [[ ! -f "$LEADS" ]]; then
  echo "Leads CSV not found: $LEADS"
  echo "Set LEADS_PATH or copy your file to data/csuite_healthcare_jun04.csv"
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example to .env and fill all 6 required API keys."
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

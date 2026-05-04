# lead-engine

TypeScript implementation of the AI Ark Campaigns lead pipeline. Implements every stage of `AIARK_CAMPAIGNS_PIPELINE_RUNBOOK.md` and adds two new OpenAI-powered functions for ICP definition and competitor discovery.

## Layout

```
.
├── index.ts                 # entry point: env load, startup gate, CLI parsing
├── functions/
│   ├── findICP.ts           # OpenAI -> ICP JSON from company + product description
│   ├── findCompetitors.ts   # OpenAI Responses + web_search -> 3 competitors
│   ├── normalizeCompany.ts  # Stage 2: OpenAI normalization (runbook prompt)
│   ├── classifyCompanyType.ts # Stage 3: company/facility classification
│   ├── classifyMx.ts        # Stage 1: MX/ESP classification + SEG drop
│   ├── findEmail.ts         # Stage 4a: TryKitt email find
│   ├── verifyEmail.ts       # Stage 4b: MillionVerifier validation
│   └── routeCampaign.ts     # Stage 5: SMTP / CatchAll routing
├── pipelines/
│   └── main.ts              # 6-stage orchestrator + artifact writer
├── integrations/
│   ├── openai.ts            # shared OpenAI client (chat + responses)
│   ├── supabase.ts          # Stage 6: chunked upsert on email
│   ├── plusvibe.ts          # Stage 5: per-lead upload + retries
│   ├── trykitt.ts           # TryKitt client
│   └── millionverifier.ts   # MillionVerifier client
├── configs/
│   └── finance.json         # campaign config (workspace + campaign IDs, ICP seed)
├── data/
│   └── leads.csv            # input CSV (replace with real file)
└── AIARK_CAMPAIGNS_PIPELINE_RUNBOOK.md   # source of truth
```

## Stage map

| Runbook stage | Module |
| --- | --- |
| §Stage 1 — MX + ESP classification | `functions/classifyMx.ts` |
| §Stage 2 — Company name normalization | `functions/normalizeCompany.ts` |
| §Stage 3 — Company/facility type classification | `functions/classifyCompanyType.ts` |
| §Stage 4a — TryKitt email find | `functions/findEmail.ts` |
| §Stage 4b — MillionVerifier validation | `functions/verifyEmail.ts` |
| §Stage 5 — PlusVibe upload + routing | `functions/routeCampaign.ts`, `integrations/plusvibe.ts` |
| §Stage 6 — Supabase upsert | `integrations/supabase.ts` |

Plus, before stage 1:

- `functions/findICP.ts` — OpenAI structured output: industries, titles, sizes, pains, geographies.
- `functions/findCompetitors.ts` — OpenAI Responses API with the `web_search` tool; returns exactly 3 competitors.

## Quickstart

```bash
npm install
cp .env.example .env       # fill in all 6 required keys (runbook §3)
# edit configs/finance.json: set company, product, workspace + campaign IDs
# put your input file at data/leads.csv (or pass --leads <path>)

npm start -- --config configs/finance.json --leads data/leads.csv
# pilot mode (first N leads only, runbook §8 step 2):
npm start -- --config configs/finance.json --leads data/leads.csv --pilot 25
```

## Outputs (per runbook §5)

Each run creates `run_outputs_<timestamp>/`:

- `enriched_leads.csv`
- `removed_leads.csv` (reasons: `security_gateway`, `no_email_found`, `email_unverified`, `unknown_domain_setting`)
- `upload_errors.csv`
- `run_summary.json` (counts per stage, drops by reason, ICP, competitors, campaign IDs used)

## Required env keys

`OPENAI_API_KEY`, `TRYKITT_API_KEY`, `MILLIONVERIFIER_API_KEY`, `PLUSVIBE_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`.

The startup gate hard-stops with an actionable message if any are missing.

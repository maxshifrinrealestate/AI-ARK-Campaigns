# AIArk Campaigns Pipeline Runbook

- **owner:** Growth Ops / RevOps
- **status:** production-guidelines
- **last_updated:** 2026-04-25

Operational runbook and guardrails for processing raw leads into Plusvibe campaigns and Supabase.

This document is written to be executable by a human operator or AI agent without guessing.

## 1) Mission and Non-Negotiables

The pipeline processes one CSV through six strict stages:

1. MX lookup + ESP classification
2. Company name normalization
3. Company/facility type classification
4. TryKitt email find + MillionVerifier validation (only when original email is missing)
5. Plusvibe campaign routing/upload
6. Supabase upsert

Non-negotiables:

- Never skip stage order.
- Never verify original CSV business emails with MillionVerifier.
- Never use TryKitt when original business email exists.
- Never upload a lead without an active email.
- Never silently drop leads; every drop must be logged with a reason.

## 2) Required Inputs

### CSV Schema

Expected columns (case-insensitive mapping allowed in implementation):

- `first_name`
- `last_name`
- `title`
- `email_business`
- `domain_settings` (`SMTP` or `CatchAll`)
- `country`
- `state`
- `city`
- `linkedin`
- `company_name`
- `company_size`
- `company_industry`
- `company_products_services`
- `company_description`
- `company_website`
- `company_linkedin`
- `company_number_of_locations`

Graceful degradation rules:

- If one or two of `company_products_services`, `company_description`, `company_name` are missing, continue using what exists.
- If all three are empty, set `company_type=unknown` and continue.
- Missing columns at file level must be warned at startup, not fatal for optional enrichments.

### Runtime Secrets and Config

Required before run:

- `OPENAI_API_KEY`
- `TRYKITT_API_KEY`
- `MILLIONVERIFIER_API_KEY`
- `PLUSVIBE_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`

Campaign routing values (must come from user per run unless centrally configured):

- SMTP Campaign:
  - Workspace ID
  - Campaign ID
- CatchAll Campaign:
  - Workspace ID
  - Campaign ID

## 3) Startup Gate (Must pass before Stage 1)

Do not begin processing until all are confirmed:

1. Input CSV path validated and readable.
2. Plusvibe SMTP workspace + campaign IDs provided.
3. Plusvibe CatchAll workspace + campaign IDs provided.
4. Supabase URL + key available.
5. TryKitt key available.
6. MillionVerifier key available.
7. OpenAI key available.

If any item is missing: stop with actionable prompt to operator.

## 4) Stage-by-Stage Execution Contract

### Stage 1: MX Lookup and ESP Classification

Input: every row.

Domain resolution priority:

1. Domain from `email_business` (if present)
2. Else from `company_website`

ESP mapping:

- Google: `google.com`, `googlemail.com`, `aspmx`
- Outlook: `outlook.com`, `hotmail.com`, `protection.outlook.com`
- REMOVE/security gateway:
  - `proofpoint.com`, `pphosted.com`
  - `mimecast.com`
  - `barracuda.com`, `barracudanetworks.com`
  - `cisco.com` (IronPort), `messagelabs.com`, `sophos.com`
- Other: everything else

Output:

- Add `esp_classification`
- If security gateway -> remove from active flow and append to `removed_leads.csv` with:
  - `reason=security_gateway`

### Stage 2: Company Name Normalization (OpenAI)

Input: all rows surviving Stage 1.

Write-only target field:

- `company_name_normalized` (never overwrite `company_name`)

Prompt contract:

```text
You are a company name normalization assistant.
Given the raw company name below, return only the clean, normalized, properly capitalized legal or trade name. Remove suffixes like "Inc", "LLC", "Ltd", "Corp", "Co." only if they appear redundant or inconsistently cased. Do not invent information. Return only the normalized name, nothing else.

Raw company name: {{company_name}}
```

Fallback:

- If model returns empty/error: copy original `company_name` to `company_name_normalized` and log failure.

### Stage 3: Company Type Classification (OpenAI)

Input: all rows surviving Stage 2.

Field priority:

1. `company_description` + `company_name_normalized` + `company_products_services`
2. Any non-empty subset
3. If all empty -> `company_type=unknown`

Prompt contract:

```text
You are a business classification assistant. Using the information below, classify this company into one specific company type or facility type. Return only a single classification label (2-5 words max). Do not explain your reasoning.

Company Name: {{company_name_normalized}}
Description: {{company_description}}
Products/Services: {{company_products_services}}
```

Post-processing rules:

- Max 5 words preferred.
- If output exceeds 6 words, truncate to first 4 words.
- If project has a dedicated company-type skill, use it first.

### Stage 4: TryKitt Find + MillionVerifier Validate

Trigger: only where `email_business` is empty/null.

Stage 4a (TryKitt):

- Inputs: `first_name`, `last_name`, `company_website` (or domain from company LinkedIn)
- Output: `email_found` (null if none)
- If null -> remove and log:
  - `reason=no_email_found`

Stage 4b (MillionVerifier):

- Only for rows with non-null `email_found`
- Output: `email_verification_status`

Accepted:

- `valid`
- `catch_all` (continue but mark as catch_all)

Rejected (remove + log `reason=email_unverified`):

- `invalid`
- `disposable`
- `unknown`
- `risky`

Critical guardrail:

- Never call MillionVerifier on `email_business`.

Active email resolution:

- If `email_business` exists -> `active_email=email_business`
- Else if `email_found` verified -> `active_email=email_found`
- Else remove from downstream

### Stage 5: Plusvibe Upload

Trigger: rows with `active_email`.

Routing by `domain_settings`:

- `SMTP` -> SMTP campaign/workspace
- `CatchAll` -> CatchAll campaign/workspace
- Anything else -> remove + log `reason=unknown_domain_setting`

Lead payload shape:

```json
{
  "email": "<active_email>",
  "first_name": "{{first_name}}",
  "last_name": "{{last_name}}",
  "company_name": "{{company_name_normalized}}",
  "title": "{{title}}",
  "linkedin": "{{linkedin}}",
  "company_website": "{{company_website}}",
  "company_linkedin": "{{company_linkedin}}",
  "company_size": "{{company_size}}",
  "company_industry": "{{company_industry}}",
  "company_type": "{{company_type}}",
  "esp": "{{esp_classification}}",
  "city": "{{city}}",
  "state": "{{state}}",
  "country": "{{country}}"
}
```

Operational rules:

- Upload one lead at a time unless API explicitly supports bulk safely.
- On upload error, append to `upload_errors.csv` (`email`, `error_message`, `campaign_id`).
- Do not auto-retry Plusvibe beyond configured retry policy.

### Stage 6: Supabase Upsert

Trigger: after Stage 5; all rows with `active_email` that were not removed.

Target table:

- `leads` (or environment-specific equivalent)

Upsert key:

- `email`

Required persisted enrichment fields:

- Raw + normalized company name
- company type
- ESP classification
- domain settings
- email source (`csv` or `trykit`)
- verification status (null for csv-sourced)
- plusvibe workspace/campaign IDs used
- location/person fields
- timestamps

Rule:

- Conflict on email must update existing row, never fail run.

## 5) Output Artifacts (Per Run)

Must produce:

- `enriched_leads.csv`: all successfully routed leads with active emails.
- `removed_leads.csv`: every dropped row + reason.
- `upload_errors.csv`: Plusvibe/API failures.
- `run_summary.json`: counts by stage, drops by reason, upload success/failure, Supabase upsert counts.

Mandatory `removed_leads.csv` reasons:

- `security_gateway`
- `email_unverified`
- `no_email_found`
- `unknown_domain_setting`

## 6) Retry and Failure Policy

Transient API failures (timeout/429/5xx):

- Retry up to 3 times with exponential backoff: 2s, 4s, 8s.
- After final failure: log and continue next row.

OpenAI failure handling:

- Normalization fail -> fallback to raw `company_name`.
- Classification fail -> `company_type=unknown`.

Pipeline-level behavior:

- Single row failure must never stop the run.
- Hard stop only for startup gate failures (missing critical keys/config/input).

## 7) Security and Compliance Guardrails

- Do not commit API keys in code, docs, or sample commands.
- Mask emails in public logs when possible.
- Never dump full PII rows into console in production.
- Restrict Supabase service-role key usage to server-side environment only.
- Keep `removed_leads.csv` and raw outputs in access-controlled storage.

## 8) Operator Runbook (Copy/Paste Checklist)

1. Validate startup gate (all 7 requirements present).
2. Run pilot (10-25 rows) and inspect:
   - classification quality
   - drop reasons
   - Plusvibe acceptance
   - Supabase upsert success
3. If pilot passes, run full dataset.
4. Archive artifacts (`enriched_leads.csv`, `removed_leads.csv`, `upload_errors.csv`, `run_summary.json`).
5. Share run summary to team channel with:
   - input count
   - eligible count
   - removed by reason
   - uploaded by campaign
   - supabase upserted

## 9) Implementation Notes for This Repository

Current repository has a working base pipeline in `pipeline/`, including:

- OpenAI enrichment
- MX/ESP classification
- Plusvibe upload
- Supabase upsert

Before claiming full Airakr spec compliance, verify and implement gaps:

- TryKitt integration for missing-email rows.
- MillionVerifier integration for TryKitt-sourced emails only.
- Stage-specific output files (`enriched_leads.csv`, `removed_leads.csv`, `upload_errors.csv`, `run_summary.json`).
- Campaign routing by `domain_settings` with explicit user-provided workspace/campaign IDs.
- Strict handling of rows lacking active email.

Use this document as the source of truth for future campaign runs and PR reviews.

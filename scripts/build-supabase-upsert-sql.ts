import fs from "node:fs";
import path from "node:path";

const batchPath = process.argv[2];
if (!batchPath) throw new Error("Usage: tsx build-supabase-upsert-sql.ts <batch.json>");

const rows = JSON.parse(fs.readFileSync(batchPath, "utf-8")) as unknown[];
const json = JSON.stringify(rows);

const sql = `
WITH data AS (
  SELECT *
  FROM jsonb_to_recordset($json$${json}$json$::jsonb) AS x(
    "Email" text,
    "First Name" text,
    "Last Name" text,
    "Linkedin" text,
    "Company Name" text,
    "Website" text
  )
),
updated AS (
  UPDATE "Lead Database" ld
  SET
    "First Name" = COALESCE(d."First Name", ld."First Name"),
    "Last Name" = COALESCE(d."Last Name", ld."Last Name"),
    "Linkedin" = COALESCE(d."Linkedin", ld."Linkedin"),
    "Company Name" = COALESCE(d."Company Name", ld."Company Name"),
    "Website" = COALESCE(d."Website", ld."Website")
  FROM data d
  WHERE lower(btrim(ld."Email")) = lower(btrim(d."Email"))
  RETURNING ld.id
)
INSERT INTO "Lead Database" ("Email", "First Name", "Last Name", "Linkedin", "Company Name", "Website")
SELECT d."Email", d."First Name", d."Last Name", d."Linkedin", d."Company Name", d."Website"
FROM data d
WHERE NOT EXISTS (
  SELECT 1 FROM "Lead Database" ld
  WHERE lower(btrim(ld."Email")) = lower(btrim(d."Email"))
);
`;

process.stdout.write(sql);

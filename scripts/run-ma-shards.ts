/**
 * Launch N parallel fast-enrichment workers over disjoint row ranges.
 *
 * Usage:
 *   npx tsx scripts/run-ma-shards.ts --input data/ma_leads.csv --shards 8 --concurrency 60
 *
 * Target: 5k leads in ~30 min with 8 shards × 60 concurrency = high parallel throughput.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function countRows(file: string): number {
  const text = fs.readFileSync(file, "utf-8");
  return (parse(text, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as unknown[])
    .length;
}

async function main(): Promise<void> {
  const input = arg("--input") ?? "data/ma_leads.csv";
  const config = arg("--config") ?? "configs/ma_advisory.json";
  const start = Number(arg("--start") ?? "0");
  const shards = Number(arg("--shards") ?? "8");
  const concurrency = arg("--concurrency") ?? "60";
  const pilotRaw = arg("--pilot");
  const quiet = process.argv.includes("--quiet");

  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);

  const total = countRows(input);
  const pool = pilotRaw ? Math.min(Number(pilotRaw), total - start) : total - start;
  if (pool <= 0) {
    console.log(`Nothing to process: total=${total} start=${start}`);
    return;
  }

  const perShard = Math.ceil(pool / shards);
  const jobs: Array<{ shard: number; startRow: number; pilot: number }> = [];

  for (let s = 0; s < shards; s++) {
    const startRow = start + s * perShard;
    if (startRow >= start + pool) break;
    const pilot = Math.min(perShard, start + pool - startRow);
    jobs.push({ shard: s, startRow, pilot });
  }

  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const outDir = path.resolve(`ma_enrich_${ts}`);
  const logDir = path.join(outDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  console.log(`[ma-shards] total=${total} pool=${pool} shards=${jobs.length} concurrency=${concurrency}/shard`);
  for (const j of jobs) {
    console.log(`  shard ${j.shard}: start=${j.startRow} pilot=${j.pilot}`);
  }

  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const children = jobs.map((j) => {
    const outCsv = path.join(outDir, `enriched_shard_${j.shard}.csv`);
    const logPath = path.join(logDir, `shard_${j.shard}.log`);
    const args = [
      tsxCli,
      "scripts/enrich-ma-outreach.ts",
      "--input",
      input,
      "--output",
      outCsv,
      "--config",
      config,
      "--start",
      String(j.startRow),
      "--pilot",
      String(j.pilot),
      "--concurrency",
      concurrency,
      "--quiet"
    ];

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", fs.openSync(logPath, "w"), fs.openSync(logPath, "a")]
    });
    return { child, shard: j.shard, outCsv, logPath };
  });

  await Promise.all(
    children.map(
      ({ child, shard }) =>
        new Promise<void>((resolve, reject) => {
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`shard ${shard} exited with code ${code}`));
          });
        })
    )
  );

  const merged: Record<string, string>[] = [];
  for (const { outCsv } of children) {
    if (!fs.existsSync(outCsv)) continue;
    const rows = parse(fs.readFileSync(outCsv, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true
    }) as Record<string, string>[];
    merged.push(...rows);
  }

  const mergedPath = path.join(outDir, "ma_leads_enriched_merged.csv");
  if (merged.length > 0) {
    const headers = Object.keys(merged[0]!);
    const lines = [headers.join(",")];
    for (const row of merged) {
      lines.push(headers.map((h) => csvEscape(row[h] ?? "")).join(","));
    }
    fs.writeFileSync(mergedPath, lines.join("\n"));
  }

  console.log(`[ma-shards] merged ${merged.length} rows → ${mergedPath}`);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

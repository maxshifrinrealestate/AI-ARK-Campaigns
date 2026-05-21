/**
 * Launch N parallel pipeline workers over disjoint row ranges (enrich + upload per row).
 *
 * Usage:
 *   npx tsx scripts/run-parallel-shards.ts --config configs/welltech_csuite_healthcare.json \
 *     --leads "C:/path/to/file.csv" --start 6400 --shards 4
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function countCsvRows(file: string): number {
  const text = fs.readFileSync(file, "utf-8");
  const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
  return rows.length;
}

async function main(): Promise<void> {
  // npm on Windows may drop named flags; accept positional: config leads [start] [shards]
  const config = arg("--config") ?? process.argv[2];
  const leads = arg("--leads") ?? process.argv[3];
  const start = Number(arg("--start") ?? process.argv[4] ?? "0");
  const shards = Number(arg("--shards") ?? process.argv[5] ?? "4");
  const emptyEmailOnly = process.argv.includes("--empty-email-only");
  if (!config || !leads) {
    throw new Error("Requires --config and --leads");
  }
  if (!Number.isFinite(start) || start < 0) throw new Error("--start must be >= 0");
  if (!Number.isFinite(shards) || shards < 1) throw new Error("--shards must be >= 1");

  let total = countCsvRows(leads);
  if (emptyEmailOnly) {
    const text = fs.readFileSync(leads, "utf-8");
    const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Record<
      string,
      string
    >[];
    total = rows.filter((r) => !String(r.email_business ?? r["Email Business"] ?? "").trim()).length;
    console.log(`[shards] empty-email-only pool size=${total}`);
  }
  const remaining = total - start;
  if (remaining <= 0) {
    console.log(`Nothing to process: total=${total} start=${start}`);
    return;
  }

  const perShard = Math.ceil(remaining / shards);
  const jobs: Array<{ shard: number; startRow: number; pilot: number }> = [];

  for (let s = 0; s < shards; s++) {
    const startRow = start + s * perShard;
    if (startRow >= total) break;
    const pilot = Math.min(perShard, total - startRow);
    jobs.push({ shard: s, startRow, pilot });
  }

  console.log(`[shards] total=${total} start=${start} remaining=${remaining} jobs=${jobs.length}`);
  for (const j of jobs) {
    console.log(`  shard ${j.shard}: --start ${j.startRow} --pilot ${j.pilot}`);
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "_");
  const logDir = path.resolve(`shard_logs_${ts}`);
  fs.mkdirSync(logDir, { recursive: true });

  const children = jobs.map((j) => {
    const logPath = path.join(logDir, `shard_${j.shard}.log`);
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const prefix = emptyEmailOnly ? "run_outputs_snf_trykitt" : `run_outputs_${ts}`;
    const outDir = path.join(process.cwd(), `${prefix}_shard${j.shard}`);
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        path.join(process.cwd(), "index.ts"),
        "--config",
        config,
        "--leads",
        leads,
        "--start",
        String(j.startRow),
        "--pilot",
        String(j.pilot),
        "--skip-icp",
        ...(emptyEmailOnly ? ["--empty-email-only"] : [])
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OUT_DIR: outDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    return { shard: j.shard, child, logPath, startRow: j.startRow, pilot: j.pilot };
  });

  const results = await Promise.all(
    children.map(
      (c) =>
        new Promise<{ shard: number; code: number | null; logPath: string; startRow: number; pilot: number }>(
          (resolve) => {
            c.child.on("exit", (code) => {
              resolve({ shard: c.shard, code, logPath: c.logPath, startRow: c.startRow, pilot: c.pilot });
            });
          }
        )
    )
  );

  console.log(`\n[shards] all workers finished. logs in ${logDir}`);
  for (const r of results) {
    console.log(
      `  shard ${r.shard} rows ${r.startRow}-${r.startRow + r.pilot - 1}: exit=${r.code} log=${r.logPath}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

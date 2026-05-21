import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import { runPipeline } from "./pipelines/main.js";

const REQUIRED_KEYS = [
  "OPENAI_API_KEY",
  "TRYKITT_API_KEY",
  "MILLIONVERIFIER_API_KEY",
  "PLUSVIBE_KEY",
  "SUPABASE_URL",
  "SUPABASE_KEY"
] as const;

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  TRYKITT_API_KEY: z.string().min(1, "TRYKITT_API_KEY is required"),
  MILLIONVERIFIER_API_KEY: z.string().min(1, "MILLIONVERIFIER_API_KEY is required"),
  PLUSVIBE_KEY: z.string().min(1, "PLUSVIBE_KEY is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a URL"),
  SUPABASE_KEY: z.string().min(1, "SUPABASE_KEY is required")
});

type CliArgs = {
  config: string;
  leads: string;
  pilot?: number;
  start?: number;
  skipIcp?: boolean;
  emptyEmailOnly?: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    config: "configs/finance.json",
    leads: "data/leads.csv"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--config":
        if (!next) throw new Error("--config requires a path");
        args.config = next;
        i++;
        break;
      case "--leads":
        if (!next) throw new Error("--leads requires a path");
        args.leads = next;
        i++;
        break;
      case "--pilot":
        if (!next) throw new Error("--pilot requires a number");
        args.pilot = Number(next);
        if (!Number.isFinite(args.pilot) || args.pilot <= 0) {
          throw new Error("--pilot must be a positive integer");
        }
        i++;
        break;
      case "--start":
        if (!next) throw new Error("--start requires a number");
        args.start = Number(next);
        if (!Number.isFinite(args.start) || args.start < 0) {
          throw new Error("--start must be a non-negative integer (0-based row index)");
        }
        i++;
        break;
      case "--skip-icp":
        args.skipIcp = true;
        break;
      case "--empty-email-only":
        args.emptyEmailOnly = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    [
      "lead-engine",
      "",
      "Usage:",
      "  npm start -- --config <path> --leads <path> [--pilot N] [--start N] [--skip-icp] [--empty-email-only]",
      "",
      "Flags:",
      "  --config   Path to campaign config JSON (default: configs/finance.json)",
      "  --leads    Path to input leads CSV     (default: data/leads.csv)",
      "  --pilot N  Process only the first N leads (runbook \u00a78 step 2)",
      "  --start N  Resume at 0-based row index N (for interrupted runs)",
      "  --skip-icp Skip ICP/competitor generation (use when resuming)",
      "  --empty-email-only  Only rows missing Email Business (TryKitt + MV; blank domain -> SMTP)",
      "",
      "Required env vars (runbook \u00a73):",
      "  " + REQUIRED_KEYS.join(", ")
    ].join("\n")
  );
}

function startupGate(args: CliArgs): void {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    console.error(
      [
        "Startup gate failed (runbook \u00a73). Missing/invalid env vars:",
        ...messages,
        "",
        "Copy .env.example to .env and fill in all required keys."
      ].join("\n")
    );
    process.exit(1);
  }

  if (!fs.existsSync(args.config)) {
    console.error(`Startup gate failed: config file not found: ${args.config}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.leads)) {
    console.error(`Startup gate failed: leads file not found: ${args.leads}`);
    process.exit(1);
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  startupGate(args);

  const outDir = process.env.OUT_DIR
    ? path.resolve(process.env.OUT_DIR)
    : path.resolve(`run_outputs_${timestamp()}`);
  console.log(`[lead-engine] starting run`);
  console.log(`[lead-engine] config=${args.config} leads=${args.leads} outDir=${outDir}`);
  if (args.pilot) console.log(`[lead-engine] pilot=${args.pilot}`);
  if (args.start) console.log(`[lead-engine] start=${args.start}`);
  if (args.skipIcp) console.log(`[lead-engine] skip-icp=true`);
  if (args.emptyEmailOnly) console.log(`[lead-engine] empty-email-only=true`);

  await runPipeline({
    configPath: args.config,
    leadsPath: args.leads,
    outDir,
    pilot: args.pilot,
    startRow: args.start,
    skipIcp: args.skipIcp,
    emptyEmailOnly: args.emptyEmailOnly,
    continuationNote: args.start
      ? `Resumed at row ${args.start}; prior segment had ~1581 Plusvibe uploads before interruption.`
      : undefined
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[lead-engine] fatal: ${msg}`);
  process.exit(1);
});

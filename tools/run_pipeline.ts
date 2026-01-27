import { runPipeline } from "../core/src";
import { reviseContent } from "../core/src/pipelines/revise/reviseContent";
import { readFile, writeFile } from "../core/src/utils/fs";
import { loadEnv } from "../core/src/utils/loadEnv";

loadEnv();

const args = process.argv.slice(2);
const tenantArg = getArgValue(args, "--tenant");
const profileId = getArgValue(args, "--profile");
const step = getArgValue(args, "--step") as
  | "ingest"
  | "analyze"
  | "generate"
  | "qa"
  | "export"
  | undefined;
const runId = getArgValue(args, "--run_id") || getArgValue(args, "--runId");
const mode = getArgValue(args, "--mode");
const inputPath = getArgValue(args, "--input");
const model = getArgValue(args, "--model") || "gpt-4.1-mini";

if (mode === "revise") {
  if (!inputPath) {
    throw new Error("Usage: --mode revise --input <path> [--model <model>] [--run_id <id>]");
  }
  const source = await readFile(inputPath);
  const result = await reviseContent({ model, sourceContent: source });
  const outputPath = `${process.cwd()}/seo_content_os_scaffold_v4/runs/${
    runId || new Date().toISOString().replace(/[:.]/g, "-")
  }/revisions/revision.json`;
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`revision.saved ${outputPath}`);
  process.exit(0);
}

if (!tenantArg || !profileId) {
  throw new Error(
    "Usage: --tenant <domain|path> --profile <profile_id> [--step ingest|analyze|generate|qa|export] [--run_id <id>]"
  );
}

const repoRoot = process.cwd();
const tenantPath = tenantArg.includes("/")
  ? tenantArg
  : `${repoRoot}/seo_content_os_scaffold_v4/tenants/${tenantArg}`;

runPipeline({ tenantPath, profileId, repoRoot, step, runId: runId || undefined }).catch((error) => {
  console.error(error);
  process.exit(1);
});

function getArgValue(argsList: string[], key: string): string | undefined {
  const index = argsList.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return argsList[index + 1];
}

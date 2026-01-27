import { readFile, writeFile } from "../core/src/utils/fs";
import { reviseContent } from "../core/src/pipelines/revise/reviseContent";
import { loadEnv } from "../core/src/utils/loadEnv";

loadEnv();

const args = process.argv.slice(2);
const inputPath = getArgValue(args, "--input");
const outputPath = getArgValue(args, "--output");
const model = getArgValue(args, "--model") || "gpt-4.1-mini";
const runId = getArgValue(args, "--run_id") || new Date().toISOString().replace(/[:.]/g, "-");

if (!inputPath) {
  throw new Error("Usage: --input <path> [--output <path>] [--model <model>] [--run_id <id>]");
}

const repoRoot = process.cwd();
const defaultOutput = `${repoRoot}/seo_content_os_scaffold_v4/runs/${runId}/revisions/revision.json`;

const source = await readFile(inputPath);
const result = await reviseContent({ model, sourceContent: source });

const targetPath = outputPath || defaultOutput;
await writeFile(targetPath, `${JSON.stringify(result, null, 2)}\n`);

console.log(`revision.saved ${targetPath}`);

function getArgValue(argsList: string[], key: string): string | undefined {
  const index = argsList.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return argsList[index + 1];
}

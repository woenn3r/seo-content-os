import { promises as fs } from "fs";
import { ensureDir } from "../core/src/utils/fs";
import { loadEnv } from "../core/src/utils/loadEnv";

loadEnv();

const args = process.argv.slice(2);
const tenantArg = getArgValue(args, "--tenant");
const dryRun = args.includes("--dry_run");

if (!tenantArg) {
  throw new Error("Usage: --tenant <domain|path> [--dry_run]");
}

const repoRoot = process.cwd();
const tenantPath = tenantArg.includes("/")
  ? tenantArg
  : `${repoRoot}/seo_content_os_scaffold_v4/tenants/${tenantArg}`;

const libraryRoot = `${tenantPath}/content_library/pages`;
const quarantineRoot = `${tenantPath}/content_library/_quarantine`;

await cleanupContentLibrary({ libraryRoot, quarantineRoot, dryRun });

type CleanupInput = {
  libraryRoot: string;
  quarantineRoot: string;
  dryRun: boolean;
};

async function cleanupContentLibrary(input: CleanupInput): Promise<void> {
  const pages = await safeReadDir(input.libraryRoot);
  for (const pageId of pages) {
    const pagePath = `${input.libraryRoot}/${pageId}`;
    if (!(await isDirectory(pagePath))) {
      continue;
    }
    const languages = await safeReadDir(pagePath);
    for (const lang of languages) {
      const langPath = `${pagePath}/${lang}`;
      if (!(await isDirectory(langPath))) {
        continue;
      }
      const status = await readQaStatus(langPath);
      if (status === "PASS") {
        continue;
      }
      const runId = await readRunId(langPath);
      const targetDir = `${input.quarantineRoot}/${pageId}/${lang}/${runId}`;
      if (input.dryRun) {
        console.log(`[dry-run] move ${langPath} -> ${targetDir}`);
      } else {
        await ensureDir(`${targetDir}/.keep`);
        await fs.rename(langPath, targetDir);
      }
    }
    await removeIfEmpty(pagePath);
  }
  await removeIfEmpty(input.libraryRoot);
}

async function readQaStatus(langPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(`${langPath}/qa_report.json`, "utf8");
    const parsed = JSON.parse(raw) as { status?: string };
    return parsed.status || "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function readRunId(langPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(`${langPath}/run_ref.json`, "utf8");
    const parsed = JSON.parse(raw) as { run_id?: string };
    return parsed.run_id || "unknown_run";
  } catch {
    return `unknown_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    const entries = await fs.readdir(path);
    if (entries.length === 0) {
      await fs.rmdir(path);
    }
  } catch {
    return;
  }
}

function getArgValue(argsList: string[], key: string): string | undefined {
  const index = argsList.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return argsList[index + 1];
}

import { RunProfile } from "../../config/loadRunProfile";
import { readCsvRows } from "../../utils/csv";
import { copyFile, ensureDir, fileExists, listFiles, readFile, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { basename } from "path";
import { getSnapshotStatus } from "../../utils/snapshot";
import { loadParsingRules, parseCsvFields } from "../../utils/parseCsvFields";

const OUTPUT_DIR = "data/04_generation/page_packages/v1";
const PAGESPEC_PATH = "data/03_strategy/pagespec/v1/11_pagespec.csv";

type Input = {
  tenantPath: string;
  runProfile: RunProfile;
  runId: string;
  runDir: string;
  resolvedPacks: { activePacks: string[] };
  siteState: string;
  snapshotStatus?: { isFresh: boolean; reason: string };
};

export async function exportPages(input: Input): Promise<void> {
  logger.info("export.start", { tenantPath: input.tenantPath, mode: input.runProfile.mode });
  const tenantName = basename(input.tenantPath);
  const sourceDir = `${input.tenantPath}/${OUTPUT_DIR}`;
  const runDir = `${input.runDir}/${tenantName}/page_packages/v1`;
  const runPagesDir = `${input.runDir}/${tenantName}/pages`;
  const libraryDir = `${input.tenantPath}/content_library/pages`;
  const shortcutDir = `${input.tenantPath}/../../content_library/${tenantName}/page_packages/v1`;

  let files: string[] = [];
  try {
    files = await listFiles(sourceDir);
  } catch {
    logger.warn("export.missing", { sourceDir });
    return;
  }

  await ensureDir(`${runDir}/.keep`);
  await ensureDir(`${libraryDir}/.keep`);
  await ensureDir(`${shortcutDir}/.keep`);

  const languageMap = await buildLanguageMap(input.tenantPath);
  const snapshotStatus =
    input.snapshotStatus || (await getSnapshotStatus(input.tenantPath, input.siteState, input.runProfile));

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const sourcePath = `${sourceDir}/${file}`;
    const pageId = file.replace(/\.json$/, "");
    const language = languageMap[pageId] || "unknown";

    const targetDir = `${libraryDir}/${pageId}/${language}`;
    const raw = await readFile(sourcePath);
    const parsed = JSON.parse(raw) as Record<string, any>;
    const qaStatus = parsed.qa?.status || "UNKNOWN";
    const allowMirror = shouldMirror(qaStatus, input.runProfile.mode, input.runProfile.blocking_policy);

    const qaReport = parsed.qa || {};

    const runPageDir = `${runPagesDir}/${pageId}/${language}`;
    await ensureDir(`${runPageDir}/.keep`);
    await writeFile(`${runPageDir}/qa_report.json`, `${JSON.stringify(qaReport, null, 2)}\n`);
    await writeFile(`${runPageDir}/pagepackage.json`, `${JSON.stringify(parsed, null, 2)}\n`);
    await writeFile(`${runPageDir}/pagepackage.min.json`, `${JSON.stringify(buildMinPagePackage(parsed), null, 2)}\n`);
    await writeFile(`${runPageDir}/page.mdx`, buildMdx(parsed));
    await writeFile(`${runPageDir}/page.html`, buildHtml(parsed, language));
    await writeFile(`${runPageDir}/schema.jsonld`, `${parsed.schema?.jsonld || ""}\n`);

    await copyFile(sourcePath, `${runDir}/${file}`);

    if (allowMirror) {
      await ensureDir(`${targetDir}/.keep`);
      await writeFile(`${targetDir}/pagepackage.json`, `${JSON.stringify(parsed, null, 2)}\n`);
      await writeFile(`${targetDir}/page.mdx`, buildMdx(parsed));
      await writeFile(`${targetDir}/page.html`, buildHtml(parsed, language));
      await writeFile(`${targetDir}/schema.jsonld`, `${parsed.schema?.jsonld || ""}\n`);
      await writeFile(`${targetDir}/qa_report.json`, `${JSON.stringify(qaReport, null, 2)}\n`);
      await writeFile(
        `${targetDir}/run_ref.json`,
        `${JSON.stringify(
          {
            run_id: input.runId,
            profile_id: input.runProfile.profile_id,
            packs: input.resolvedPacks.activePacks,
            blocking_policy: input.runProfile.blocking_policy,
            site_state: input.siteState,
            snapshot_used: snapshotStatus.isFresh,
            snapshot_reason: snapshotStatus.reason,
            qa_report_path: `${targetDir}/qa_report.json`,
            qa_checks_log_path: `${runPagesDir}/${pageId}/${language}/qa_checks_log.json`,
            created_at: new Date().toISOString(),
          },
          null,
          2
        )}\n`
      );
      await copyIfExists(`${runPageDir}/external_sources.json`, `${targetDir}/external_sources.json`);
      await copyIfExists(`${runPageDir}/retrieval_summary.json`, `${targetDir}/retrieval_summary.json`);
      await copyFile(sourcePath, `${shortcutDir}/${file}`);
    }
  }

  logger.info("export.done", { tenantPath: input.tenantPath });
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await fileExists(sourcePath))) {
    return;
  }
  await copyFile(sourcePath, targetPath);
}

async function buildLanguageMap(tenantPath: string): Promise<Record<string, string>> {
  const rows = await readCsvRows(`${tenantPath}/${PAGESPEC_PATH}`);
  const parsingRules = await loadParsingRules(process.cwd());
  const map: Record<string, string> = {};
  for (const row of rows) {
    const parsed = parseCsvFields(row, parsingRules);
    const pageId = parsed.page_id ? String(parsed.page_id) : "";
    const language = parsed.language ? String(parsed.language) : "";
    if (pageId && language) {
      map[pageId] = language;
    }
  }
  return map;
}

function buildMdx(payload: Record<string, any>): string {
  const title = payload.content?.h1 || "Untitled";
  const body = payload.content?.body || "";
  return `# ${title}\n\n${body}\n`;
}

function buildHtml(payload: Record<string, any>, language: string): string {
  const title = payload.content?.h1 || "Untitled";
  const body = payload.content?.body || "";
  const lang = language || "und";
  return `<!doctype html>\n<html lang=\"${lang}\">\n<head><meta charset=\"utf-8\"><title>${title}</title></head>\n<body><h1>${title}</h1><p>${body}</p></body>\n</html>\n`;
}

function buildMinPagePackage(payload: Record<string, any>): Record<string, unknown> {
  const sections = Array.isArray(payload.content?.sections) ? payload.content.sections : [];
  return {
    meta: {
      title: payload.meta?.title || "",
      description: payload.meta?.description || "",
      canonical: payload.meta?.canonical || "",
      robots: payload.meta?.robots || "",
    },
    url: {
      slug: payload.url?.slug || "",
    },
    content: {
      h1: payload.content?.h1 || "",
      sections: sections.map((section: any) => ({
        id: section?.id || "",
        heading: section?.heading || "",
        intent: section?.intent || "",
        key_points: Array.isArray(section?.key_points) ? section.key_points : [],
      })),
      faq: Array.isArray(payload.content?.faq)
        ? payload.content.faq.map((item: any) => ({
            question: item?.question || "",
            schema_include: item?.schema_include === true,
          }))
        : [],
    },
    internal_links: {
      outbound: Array.isArray(payload.internal_links?.outbound) ? payload.internal_links.outbound : [],
    },
  };
}

function shouldMirror(
  qaStatus: string,
  mode: string | undefined,
  blockingPolicy: Record<string, string> | undefined
): boolean {
  if (mode === "strict_production") {
    return qaStatus === "PASS";
  }
  if (qaStatus === "PASS") {
    return true;
  }
  if (qaStatus === "WARN") {
    return blockingPolicy?.warn === "allow";
  }
  return false;
}

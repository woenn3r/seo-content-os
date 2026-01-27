import { readCsvRows } from "../../utils/csv";
import { copyFile, ensureDir, listFiles, readFile, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { basename } from "path";
import { getSnapshotStatus } from "../../utils/snapshot";
const OUTPUT_DIR = "data/04_generation/page_packages/v1";
const PAGESPEC_PATH = "data/03_strategy/pagespec/v1/11_pagespec.csv";
export async function exportPages(input) {
    logger.info("export.start", { tenantPath: input.tenantPath, mode: input.runProfile.mode });
    const tenantName = basename(input.tenantPath);
    const sourceDir = `${input.tenantPath}/${OUTPUT_DIR}`;
    const runDir = `${input.runDir}/${tenantName}/page_packages/v1`;
    const libraryDir = `${input.tenantPath}/content_library/pages`;
    const shortcutDir = `${input.tenantPath}/../../content_library/${tenantName}/page_packages/v1`;
    let files = [];
    try {
        files = await listFiles(sourceDir);
    }
    catch {
        logger.warn("export.missing", { sourceDir });
        return;
    }
    await ensureDir(`${runDir}/.keep`);
    await ensureDir(`${libraryDir}/.keep`);
    await ensureDir(`${shortcutDir}/.keep`);
    const languageMap = await buildLanguageMap(input.tenantPath);
    const snapshotStatus = input.snapshotStatus || (await getSnapshotStatus(input.tenantPath, input.siteState, input.runProfile));
    for (const file of files.filter((name) => name.endsWith(".json"))) {
        const sourcePath = `${sourceDir}/${file}`;
        const pageId = file.replace(/\.json$/, "");
        const language = languageMap[pageId] || "unknown";
        const targetDir = `${libraryDir}/${pageId}/${language}`;
        await ensureDir(`${targetDir}/.keep`);
        const raw = await readFile(sourcePath);
        const parsed = JSON.parse(raw);
        await writeFile(`${targetDir}/pagepackage.json`, `${JSON.stringify(parsed, null, 2)}\n`);
        await writeFile(`${targetDir}/page.mdx`, buildMdx(parsed));
        await writeFile(`${targetDir}/page.html`, buildHtml(parsed, language));
        await writeFile(`${targetDir}/schema.jsonld`, `${parsed.schema?.jsonld || ""}\n`);
        await writeFile(`${targetDir}/qa_report.json`, `${JSON.stringify(parsed.qa || {}, null, 2)}\n`);
        await writeFile(`${targetDir}/run_ref.json`, `${JSON.stringify({
            run_id: input.runId,
            profile_id: input.runProfile.profile_id,
            packs: input.resolvedPacks.activePacks,
            blocking_policy: input.runProfile.blocking_policy,
            site_state: input.siteState,
            snapshot_used: snapshotStatus.isFresh,
            snapshot_reason: snapshotStatus.reason,
            created_at: new Date().toISOString(),
        }, null, 2)}\n`);
        await copyFile(sourcePath, `${runDir}/${file}`);
        await copyFile(sourcePath, `${shortcutDir}/${file}`);
    }
    logger.info("export.done", { tenantPath: input.tenantPath });
}
async function buildLanguageMap(tenantPath) {
    const rows = await readCsvRows(`${tenantPath}/${PAGESPEC_PATH}`);
    const map = {};
    for (const row of rows) {
        if (row.page_id && row.language) {
            map[row.page_id] = row.language;
        }
    }
    return map;
}
function buildMdx(payload) {
    const title = payload.content?.h1 || "Untitled";
    const body = payload.content?.body || "";
    return `# ${title}\n\n${body}\n`;
}
function buildHtml(payload, language) {
    const title = payload.content?.h1 || "Untitled";
    const body = payload.content?.body || "";
    const lang = language || "und";
    return `<!doctype html>\n<html lang=\"${lang}\">\n<head><meta charset=\"utf-8\"><title>${title}</title></head>\n<body><h1>${title}</h1><p>${body}</p></body>\n</html>\n`;
}

import { readFile, writeFile } from "../core/src/utils/fs";
import { logger } from "../core/src/utils/logger";
const args = process.argv.slice(2);
const tenantArg = getArgValue(args, "--tenant");
const pageId = getArgValue(args, "--page_id");
const primaryKeyword = getArgValue(args, "--primary_keyword") || pageId || "";
const offerId = getArgValue(args, "--offer_id") || "offer_seo";
const pageType = getArgValue(args, "--page_type") || "service_page";
const intent = getArgValue(args, "--intent") || "commercial";
const language = getArgValue(args, "--language") || "de";
const region = getArgValue(args, "--region") || "default";
if (!tenantArg || !pageId) {
    throw new Error("Usage: --tenant <domain|path> --page_id <id> [--primary_keyword <kw>] [--offer_id <id>] [--page_type <type>] [--intent <intent>] [--language <code>] [--region <id>]");
}
const repoRoot = process.cwd();
const tenantPath = tenantArg.includes("/")
    ? tenantArg
    : `${repoRoot}/seo_content_os_scaffold_v4/tenants/${tenantArg}`;
const pagespecPath = `${tenantPath}/data/03_strategy/pagespec/v1/11_pagespec.csv`;
(async () => {
    warnDefaults();
    const raw = await readFile(pagespecPath);
    const lines = raw.split(/\r?\n/);
    const header = lines[0] || "";
    const columns = header.split(",");
    const row = buildRow(columns, {
        page_id: pageId,
        target_url: `/${pageId.replace(/_/g, "-")}`,
        page_type: pageType,
        language,
        region,
        primary_keyword: primaryKeyword,
        intent,
        offer_id: offerId,
    });
    const next = raw.trimEnd() + "\n" + row + "\n";
    await writeFile(pagespecPath, next);
    logger.info("page.created", { tenantPath, pageId });
})();
function buildRow(columns, values) {
    return columns
        .map((column) => escapeCsv(values[column] || ""))
        .join(",");
}
function escapeCsv(value) {
    if (value.includes("\"")) {
        value = value.replace(/\"/g, "\"\"");
    }
    if (value.includes(",") || value.includes("\n")) {
        return `"${value}"`;
    }
    return value;
}
function getArgValue(argsList, key) {
    const index = argsList.indexOf(key);
    if (index === -1) {
        return undefined;
    }
    return argsList[index + 1];
}
function warnDefaults() {
    if (!getArgValue(args, "--page_type")) {
        logger.warn("page.create.default", { field: "page_type", value: pageType });
    }
    if (!getArgValue(args, "--intent")) {
        logger.warn("page.create.default", { field: "intent", value: intent });
    }
    if (!getArgValue(args, "--language")) {
        logger.warn("page.create.default", { field: "language", value: language });
    }
}

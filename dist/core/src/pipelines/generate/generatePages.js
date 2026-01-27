import { readCsvRows } from "../../utils/csv";
import { ensureDir, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { normalizeUrl } from "../../utils/url";
const PAGESPEC_PATH = "data/03_strategy/pagespec/v1/11_pagespec.csv";
const OUTPUT_DIR = "data/04_generation/page_packages/v1";
export async function generatePages(input) {
    logger.info("generate.start", { tenantPath: input.tenantPath });
    const specPath = `${input.tenantPath}/${PAGESPEC_PATH}`;
    const rows = await readCsvRows(specPath);
    if (rows.length === 0) {
        logger.warn("generate.empty", { specPath });
        return;
    }
    for (const row of rows) {
        if (!row.page_id) {
            continue;
        }
        const pagePackage = buildPagePackage(row);
        const targetPath = `${input.tenantPath}/${OUTPUT_DIR}/${row.page_id}.json`;
        await ensureDir(targetPath);
        await writeFile(targetPath, `${JSON.stringify(pagePackage, null, 2)}\n`);
    }
    logger.info("generate.done", { tenantPath: input.tenantPath });
}
function buildPagePackage(row) {
    const primaryKeyword = row.primary_keyword || row.page_id || "Stub";
    const slug = extractSlug(row.target_url || `/${row.page_id}`);
    return {
        meta: {
            title: `${primaryKeyword} | ${row.offer_id || "Service"}`,
            description: `Stub description for ${primaryKeyword}.`,
            canonical: row.target_url || undefined,
            robots: "index,follow",
        },
        url: {
            slug,
            breadcrumbs: [primaryKeyword],
        },
        content: {
            h1: primaryKeyword,
            sections: [],
            body: `Stub content for ${primaryKeyword}.`,
        },
        internal_links: {
            outbound: [],
            inbound_suggestions: [],
        },
        schema: {
            jsonld: "{}",
            notes: "stub",
        },
        qa: {
            status: "PASS",
            fail_rules: [],
            warn_rules: [],
            fix_list: [],
            completeness_score: 100,
            assumptions: ["Stub generator"],
        },
    };
}
function extractSlug(targetUrl) {
    const normalized = normalizeUrl(targetUrl);
    if (!normalized) {
        return "/";
    }
    try {
        const url = new URL(normalized);
        return url.pathname || "/";
    }
    catch {
        if (normalized.startsWith("/")) {
            return normalized;
        }
        return `/${normalized}`;
    }
}

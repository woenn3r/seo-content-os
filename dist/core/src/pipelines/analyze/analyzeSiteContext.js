import { ensureDir, fileExists, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
const DUPLICATE_PATH = "data/03_strategy/analysis_outputs/v1/duplicate_content_report.csv";
const CANNIBAL_PATH = "data/03_strategy/analysis_outputs/v1/keyword_cannibalization_report.csv";
const LINK_GRAPH_PATH = "data/03_strategy/analysis_outputs/v1/internal_link_graph.csv";
const DUPLICATE_HEADER = "issue_id,language,region,url_a,url_b,similarity_score,reason,recommended_action,severity,notes";
const CANNIBAL_HEADER = "issue_id,keyword,language,region,conflicting_urls,recommended_primary_url,reason,severity,notes";
const LINK_GRAPH_HEADER = "from_url,to_url,anchor_text,follow,placement_hint,notes";
export async function analyzeSiteContext(input) {
    logger.info("analyze.start", { tenantPath: input.tenantPath });
    await ensureCsvWithHeader(`${input.tenantPath}/${DUPLICATE_PATH}`, DUPLICATE_HEADER);
    await ensureCsvWithHeader(`${input.tenantPath}/${CANNIBAL_PATH}`, CANNIBAL_HEADER);
    await ensureCsvWithHeader(`${input.tenantPath}/${LINK_GRAPH_PATH}`, LINK_GRAPH_HEADER);
    logger.info("analyze.done", { tenantPath: input.tenantPath });
}
async function ensureCsvWithHeader(path, header) {
    if (await fileExists(path)) {
        return;
    }
    await ensureDir(path);
    await writeFile(path, `${header}\n`);
}

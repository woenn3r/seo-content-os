import { ensureDir, fileExists, readFile, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";

const SNAPSHOT_PATH = "data/02_ingest/site_content_snapshot/v1/07_site_content_snapshot.csv";
const LINK_GRAPH_PATH = "data/03_strategy/analysis_outputs/v1/internal_link_graph.csv";
const DUPLICATE_PATH = "data/03_strategy/analysis_outputs/v1/duplicate_content_report.csv";
const CANNIBAL_PATH = "data/03_strategy/analysis_outputs/v1/keyword_cannibalization_report.csv";

const SNAPSHOT_HEADER =
  "url,language,region,canonical_url,meta_title,meta_description,h1,headings_h2,headings_h3,main_text,word_count,content_hash,extracted_at,notes";
const LINK_GRAPH_HEADER = "from_url,to_url,anchor_text,follow,placement_hint,notes";
const DUPLICATE_HEADER =
  "issue_id,language,region,url_a,url_b,similarity_score,reason,recommended_action,severity,notes";
const CANNIBAL_HEADER =
  "issue_id,keyword,language,region,conflicting_urls,recommended_primary_url,reason,severity,notes";

type Input = {
  tenantPath: string;
};

export async function crawlSite(input: Input): Promise<void> {
  logger.info("crawl.start", { tenantPath: input.tenantPath });

  const snapshotPath = `${input.tenantPath}/${SNAPSHOT_PATH}`;
  await ensureCsvWithHeader(snapshotPath, SNAPSHOT_HEADER);
  await ensureCsvWithHeader(`${input.tenantPath}/${LINK_GRAPH_PATH}`, LINK_GRAPH_HEADER);
  await ensureCsvWithHeader(`${input.tenantPath}/${DUPLICATE_PATH}`, DUPLICATE_HEADER);
  await ensureCsvWithHeader(`${input.tenantPath}/${CANNIBAL_PATH}`, CANNIBAL_HEADER);

  const snapshotContents = await readIfExists(snapshotPath);
  if (snapshotContents && snapshotContents.trim().split(/\r?\n/).length === 1) {
    await writeFile(snapshotPath, `${snapshotContents.trim()}\n${buildSnapshotSampleRow()}\n`);
  }

  logger.info("crawl.done", { tenantPath: input.tenantPath });
}

async function ensureCsvWithHeader(path: string, header: string): Promise<void> {
  if (await fileExists(path)) {
    return;
  }

  await ensureDir(path);
  await writeFile(path, `${header}\n`);
}

async function readIfExists(path: string): Promise<string | null> {
  if (!(await fileExists(path))) {
    return null;
  }
  return readFile(path);
}
function buildSnapshotSampleRow(): string {
  const now = new Date().toISOString();
  return [
    "https://example.com/",
    "de",
    "default",
    "https://example.com/",
    "SEO Beratung Beispiel",
    "Stub description for crawl snapshot.",
    "SEO Beratung",
    "Leistungen||Vorgehen",
    "Audit||Optimierung",
    "Stub main text for crawl snapshot.",
    "6",
    "stub_hash",
    now,
    "stub",
  ].join(",");
}

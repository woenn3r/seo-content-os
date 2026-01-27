import { readCsvHeaders, readCsvRows } from "../core/src/utils/csv";
import { ensureDir, fileExists, writeFile } from "../core/src/utils/fs";
import { basename, dirname } from "path";
import { accessSync, promises as fs } from "fs";

const repoRoot = process.cwd();
const topicsDir = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics`;
const registryPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_registry.csv`;
const assetsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/assets/v1/assets_registry.csv`;
const legacyRegistryPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_registry_v1.csv`;
const legacyAssetsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/registry/v1/assets_registry.csv`;

const requiredTopicColumns = [
  "topic_id",
  "topic_name",
  "status",
  "supersedes_topic_id",
  "doc_md_path",
  "rules_csv_path",
  "qa_rules_csv_path",
  "prompt_fragment_path",
];

const requiredAssetColumns = [
  "asset_id",
  "asset_type",
  "scope",
  "topic_id",
  "pack_id",
  "version",
  "path",
  "status",
  "replaces_asset_id",
  "created_at",
  "last_reviewed_at",
  "owner",
  "notes",
];

async function main() {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (await fileExists(legacyRegistryPath)) {
    errors.push("Legacy registry still present: seo_content_os_scaffold_v4/shared/topics/v1/topic_registry_v1.csv");
  }
  if (await fileExists(legacyAssetsPath)) {
    errors.push("Legacy assets registry still present: seo_content_os_scaffold_v4/shared/registry/v1/assets_registry.csv");
  }

  const topicHeaders = await readCsvHeaders(registryPath);
  requiredTopicColumns.forEach((col) => {
    if (!topicHeaders.includes(col)) {
      errors.push(`topic_registry missing column: ${col}`);
    }
  });

  const assetHeaders = await readCsvHeaders(assetsPath);
  requiredAssetColumns.forEach((col) => {
    if (!assetHeaders.includes(col)) {
      errors.push(`assets_registry missing column: ${col}`);
    }
  });

  const topics = await readCsvRows(registryPath);
  const assets = await readCsvRows(assetsPath);

  const topicIdCounts = new Map<string, number>();
  topics.forEach((row) => {
    const id = row.topic_id || "";
    if (!id) {
      errors.push("Topic missing topic_id");
      return;
    }
    topicIdCounts.set(id, (topicIdCounts.get(id) || 0) + 1);
  });
  topicIdCounts.forEach((count, id) => {
    if (count > 1) {
      errors.push(`Duplicate topic_id: ${id}`);
    }
  });

  const rulePathMap = new Map<string, string[]>();
  for (const row of topics) {
    const status = (row.status || "").toLowerCase();
    const rulesPath = row.rules_csv_path || "";
    const qaPath = row.qa_rules_csv_path || "";
    if (rulesPath) {
      const list = rulePathMap.get(rulesPath) || [];
      list.push(row.topic_id || "unknown");
      rulePathMap.set(rulesPath, list);
    }
    if (qaPath) {
      const list = rulePathMap.get(qaPath) || [];
      list.push(row.topic_id || "unknown");
      rulePathMap.set(qaPath, list);
    }
    if (status === "implemented") {
      ensurePathExists(row.doc_md_path, row, warnings, errors);
      ensurePathExists(row.rules_csv_path, row, warnings, errors);
      ensurePathExists(row.qa_rules_csv_path, row, warnings, errors);
      ensurePathExists(row.prompt_fragment_path, row, warnings, errors);
    } else {
      if (row.doc_md_path) {
        await maybeAutoCreateTopicDoc(row);
      }
    }
  }

  await validateTopicDocs(topics, warnings, errors);

  for (const [path, ids] of rulePathMap.entries()) {
    if (ids.length < 2) {
      continue;
    }
    const hasSupersedes = ids.some((id) => {
      const row = topics.find((topic) => topic.topic_id === id);
      if (!row) {
        return false;
      }
      const supersedes = (row.supersedes_topic_id || "")
        .split(/[;,]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      return supersedes.some((sup) => ids.includes(sup));
    });
    if (!hasSupersedes) {
      errors.push(`Multiple topics share rule file without supersedes: ${path} -> ${ids.join(", ")}`);
    }
  }

  const assetIdCounts = new Map<string, number>();
  const assetIndex = new Map<string, Record<string, string>>();
  assets.forEach((row) => {
    const id = row.asset_id || "";
    if (!id) {
      errors.push("Asset missing asset_id");
      return;
    }
    assetIdCounts.set(id, (assetIdCounts.get(id) || 0) + 1);
    assetIndex.set(id, row);
  });
  assetIdCounts.forEach((count, id) => {
    if (count > 1) {
      errors.push(`Duplicate asset_id: ${id}`);
    }
  });

  assets.forEach((row) => {
    const status = (row.status || "").toLowerCase();
    if (!["active", "deprecated"].includes(status)) {
      errors.push(`Asset status invalid for ${row.asset_id}: ${row.status}`);
    }
    if (!row.version) {
      errors.push(`Asset missing version: ${row.asset_id}`);
    }
    if (row.replaces_asset_id) {
      const replaced = assetIndex.get(row.replaces_asset_id);
      if (!replaced) {
        errors.push(`Asset replaces_asset_id not found: ${row.asset_id} -> ${row.replaces_asset_id}`);
      }
    }
  });

  const implementedTopics = topics.filter((row) => (row.status || "").toLowerCase() === "implemented");
  implementedTopics.forEach((row) => {
    const hasAsset = assets.some((asset) => asset.topic_id === row.topic_id);
    if (!hasAsset) {
      errors.push(`Implemented topic missing assets_registry entries: ${row.topic_id}`);
    }
  });

  const superseded = new Set<string>();
  topics.forEach((row) => {
    const supersedes = (row.supersedes_topic_id || "")
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    supersedes.forEach((id) => superseded.add(id));
  });
  superseded.forEach((id) => {
    const row = topics.find((topic) => topic.topic_id === id);
    if (!row) {
      warnings.push(`supersedes_topic_id references missing topic: ${id}`);
      return;
    }
    if ((row.status || "").toLowerCase() !== "deprecated") {
      warnings.push(`Topic superseded but not deprecated: ${id}`);
    }
  });

  if (warnings.length > 0) {
    console.warn(`validate_registries.warn (${warnings.length} warnings)`);
    warnings.forEach((warning) => console.warn(`- ${warning}`));
  }

  if (errors.length > 0) {
    console.error(`validate_registries.failed (${errors.length} errors)`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }

  console.log("validate_registries.ok");
}

function resolvePath(path: string) {
  if (!path) {
    return "";
  }
  if (path.startsWith("seo_content_os_scaffold_v4/")) {
    return `${repoRoot}/${path}`;
  }
  return path;
}

function ensurePathExists(
  path: string,
  row: Record<string, string>,
  warnings: string[],
  errors: string[]
) {
  if (!path) {
    errors.push(`Missing path for topic ${row.topic_id}`);
    return;
  }
  const resolved = resolvePath(path);
  if (!resolved) {
    errors.push(`Invalid path for topic ${row.topic_id}: ${path}`);
    return;
  }
  if (!fileExistsSync(resolved)) {
    errors.push(`Missing file for topic ${row.topic_id}: ${path}`);
  }
}

async function maybeAutoCreateTopicDoc(row: Record<string, string>) {
  const docPath = resolvePath(row.doc_md_path || "");
  if (!docPath) {
    return;
  }
  if (await fileExists(docPath)) {
    return;
  }
  const topicId = row.topic_id || basename(docPath).replace(/\.md$/, "");
  const content = buildFrontmatter(row, topicId);
  await ensureDir(docPath);
  await writeFile(docPath, `${content}\n\n`);
}

async function validateTopicDocs(
  topics: Record<string, string>[],
  warnings: string[],
  errors: string[]
) {
  for (const row of topics) {
    const path = resolvePath(row.doc_md_path || "");
    if (!path || !(await fileExists(path))) {
      continue;
    }
    const raw = await fs.readFile(path, "utf8");
    if (!raw.trimStart().startsWith("---")) {
      errors.push(`Topic missing frontmatter: ${row.topic_id}`);
      continue;
    }
    const frontmatter = raw.split("---").slice(1, 2)[0] || "";
    const fields = parseFrontmatter(frontmatter);
    if (fields.topic_id && fields.topic_id !== row.topic_id) {
      errors.push(`topic_id mismatch in frontmatter for ${row.topic_id}: ${fields.topic_id}`);
    }
  const dirName = basename(dirname(path));
    if (dirName !== "v1") {
      warnings.push(`topic.md not under v1 folder: ${row.topic_id}`);
    }
  }
}

function parseFrontmatter(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    fields[key] = value.replace(/^\"|\"$/g, "");
  }
  return fields;
}

function buildFrontmatter(row: Record<string, string>, topicId: string): string {
  const title = row.topic_name || row.topic_id || "Topic";
  const scope = row.scope || "global";
  const applies = row.page_types || "all";
  const status = mapStatus(row.status || "draft");
  const supersedes = (row.supersedes_topic_id || "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const appliesList = applies
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [
    "---",
    `topic_id: ${topicId}`,
    `title: ${escapeYaml(title)}`,
    `scope: ${scope || "global"}`,
    `applies_to: [${appliesList.length ? appliesList.join(", ") : "all"}]`,
    "version: v1",
    `status: ${status}`,
    `supersedes: [${supersedes.join(", ")}]`,
    "---",
  ].join("\n");
}

function mapStatus(status: string): string {
  const value = status.toLowerCase();
  if (value === "active" || value === "deprecated") {
    return value;
  }
  if (value === "implemented") {
    return "active";
  }
  return "draft";
}

function escapeYaml(value: string): string {
  if (value.includes(":") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/\"/g, "\\\"")}"`;
  }
  return value;
}

function fileExistsSync(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

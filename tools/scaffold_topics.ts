import { readCsvRows } from "../core/src/utils/csv";
import { ensureDir, fileExists, readFile, writeFile } from "../core/src/utils/fs";
import { basename } from "path";

const repoRoot = process.cwd();
const registryPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_registry.csv`;
const topicsBase = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics`;
const legacyNotesDir = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_notes`;

async function main() {
  const rows = await readCsvRows(registryPath);
  for (const row of rows) {
    const topicId = row.topic_id || "";
    if (!topicId) {
      continue;
    }
    const docPath = row.doc_md_path || `${topicsBase}/${topicId}/v1/topic.md`;
    const topicDir = `${topicsBase}/${topicId}/v1`;
    await ensureDir(`${topicDir}/.keep`);

    await ensureTopicMarkdown(docPath, row, topicId);
    await ensurePlaceholder(`${topicDir}/rules.yaml`, "# rules\n");
    await ensurePlaceholder(`${topicDir}/tests.yaml`, "# tests\n");
    await ensurePlaceholder(`${topicDir}/changelog.md`, "# Changelog\n\n## v1\n- Initial scaffold\n");

    const rulesCsv = row.rules_csv_path || `${topicDir}/rules.csv`;
    const qaCsv = row.qa_rules_csv_path || `${topicDir}/qa_rules.csv`;
    const promptFragment = row.prompt_fragment_path || `${topicDir}/prompt_fragment.md`;
    await ensurePlaceholder(rulesCsv, "rule_id,description\n");
    await ensurePlaceholder(qaCsv, "rule_id,description\n");
    await ensurePlaceholder(promptFragment, "");
  }
}

async function ensureTopicMarkdown(path: string, row: Record<string, string>, topicId: string) {
  const legacyPath = `${legacyNotesDir}/${topicId}.md`;
  const exists = await fileExists(path);
  let body = "";
  if (!exists && (await fileExists(legacyPath))) {
    body = await readFile(legacyPath);
  } else if (exists) {
    body = await readFile(path);
  }

  const hasFrontmatter = body.trimStart().startsWith("---");
  const frontmatter = buildFrontmatter(row, topicId);
  const content = hasFrontmatter ? body : `${frontmatter}\n\n${body || ""}`.trimEnd() + "\n";
  await ensureDir(path);
  await writeFile(path, content);
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

async function ensurePlaceholder(path: string, contents: string) {
  if (await fileExists(path)) {
    return;
  }
  await ensureDir(path);
  await writeFile(path, contents);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

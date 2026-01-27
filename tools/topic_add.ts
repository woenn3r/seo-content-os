import { readCsvRows, writeCsvRows } from "../core/src/utils/csv";
import { ensureDir, fileExists, writeFile } from "../core/src/utils/fs";

const repoRoot = process.cwd();
const registryPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_registry.csv`;
const notesDir = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_notes`;

async function main() {
  const args = process.argv.slice(2);
  const title = getArgValue(args, "--title");
  if (!title) {
    throw new Error("Usage: --title <title> [--dedupe_key <key>] [--status active|inactive]");
  }
  const dedupeKey = getArgValue(args, "--dedupe_key") || slugify(title);
  const status = (getArgValue(args, "--status") || "active").toLowerCase();
  const priority = getArgValue(args, "--priority") || "normal";
  const now = new Date().toISOString();

  const rows = await readCsvRows(registryPath);
  const duplicate = rows.find(
    (row) => row.dedupe_key === dedupeKey && (row.status || "").toLowerCase() === "active"
  );
  if (duplicate) {
    throw new Error(`Active topic with dedupe_key '${dedupeKey}' already exists (${duplicate.topic_id}).`);
  }

  const topicId = slugify(getArgValue(args, "--topic_id") || dedupeKey);
  const notesPath = `${notesDir}/${topicId}.md`;
  await ensureDir(notesPath);
  if (!(await fileExists(notesPath))) {
    const content = `# ${title}\n\n## Summary\n\n## Links\n\n`;
    await writeFile(notesPath, content);
  }

  rows.push({
    topic_id: topicId,
    dedupe_key: dedupeKey,
    title,
    status,
    priority,
    created_at: now,
    updated_at: now,
    notes_path: `seo_content_os_scaffold_v4/shared/topics/v1/topic_notes/${topicId}.md`,
    linked_assets: "",
  });

  await writeCsvRows(
    registryPath,
    [
      "topic_id",
      "dedupe_key",
      "title",
      "status",
      "priority",
      "created_at",
      "updated_at",
      "notes_path",
      "linked_assets",
    ],
    rows
  );

  console.log(`topic.added ${topicId}`);
}

function getArgValue(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

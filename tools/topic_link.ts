import { readCsvRows, writeCsvRows } from "../core/src/utils/csv";

const repoRoot = process.cwd();
const topicsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_registry.csv`;
const assetsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/assets/v1/assets_registry.csv`;

async function main() {
  const args = process.argv.slice(2);
  const topicId = getArgValue(args, "--topic_id");
  const dedupeKey = getArgValue(args, "--dedupe_key");
  const assetId = getArgValue(args, "--asset_id");
  const assetKey = getArgValue(args, "--asset_key");

  if ((!topicId && !dedupeKey) || (!assetId && !assetKey)) {
    throw new Error("Usage: --topic_id <id>|--dedupe_key <key> --asset_id <id>|--asset_key <key>");
  }

  const topics = await readCsvRows(topicsPath);
  const assets = await readCsvRows(assetsPath);

  const topic = topics.find((row) =>
    topicId ? row.topic_id === topicId : row.dedupe_key === dedupeKey
  );
  if (!topic) {
    throw new Error("Topic not found.");
  }

  const asset = assets.find((row) =>
    assetId ? row.asset_id === assetId : row.dedupe_key === assetKey
  );
  if (!asset) {
    throw new Error("Asset not found.");
  }

  const linked = (topic.linked_assets || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!linked.includes(asset.asset_id)) {
    linked.push(asset.asset_id);
  }
  topic.linked_assets = linked.join(";");
  topic.updated_at = new Date().toISOString();

  await writeCsvRows(
    topicsPath,
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
    topics
  );

  console.log(`topic.linked ${topic.topic_id} -> ${asset.asset_id}`);
}

function getArgValue(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

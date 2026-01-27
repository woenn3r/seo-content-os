import { readCsvRows } from "../core/src/utils/csv";
import { fileExists } from "../core/src/utils/fs";

const repoRoot = process.cwd();
const topicsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/topics/v1/topic_registry.csv`;
const assetsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/assets/v1/assets_registry.csv`;

async function main() {
  const errors: string[] = [];

  const topics = await readCsvRows(topicsPath);
  const assets = await readCsvRows(assetsPath);

  const activeDedupe = new Map<string, string[]>();
  topics.forEach((row) => {
    const status = (row.status || "").toLowerCase();
    if (status !== "active") {
      return;
    }
    const dedupe = row.dedupe_key || "";
    if (!dedupe) {
      errors.push(`Topic missing dedupe_key: ${row.topic_id || "unknown"}`);
      return;
    }
    const list = activeDedupe.get(dedupe) || [];
    list.push(row.topic_id || "unknown");
    activeDedupe.set(dedupe, list);
  });

  activeDedupe.forEach((ids, key) => {
    if (ids.length > 1) {
      errors.push(`Duplicate active dedupe_key '${key}' for topics: ${ids.join(", ")}`);
    }
  });

  const assetIndex = new Map<string, { asset_id: string; file_path: string; pack_id: string }>();
  assets.forEach((row) => {
    assetIndex.set(row.asset_id, {
      asset_id: row.asset_id,
      file_path: row.file_path,
      pack_id: row.pack_id,
    });
    if (row.dedupe_key) {
      assetIndex.set(row.dedupe_key, {
        asset_id: row.asset_id,
        file_path: row.file_path,
        pack_id: row.pack_id,
      });
    }
  });

  for (const row of topics) {
    const status = (row.status || "").toLowerCase();
    if (status !== "active") {
      continue;
    }
    const notesPath = row.notes_path || "";
    if (!notesPath) {
      errors.push(`Topic missing notes_path: ${row.topic_id}`);
    } else if (!(await fileExists(`${repoRoot}/${notesPath}`))) {
      errors.push(`Missing topic notes file: ${notesPath}`);
    }

    const links = (row.linked_assets || "")
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (links.length === 0) {
      errors.push(`Topic ${row.topic_id} missing linked_assets`);
      continue;
    }
    for (const link of links) {
      const asset = assetIndex.get(link);
      if (!asset) {
        errors.push(`Topic ${row.topic_id} linked asset not found: ${link}`);
        continue;
      }
      if (!asset.pack_id) {
        errors.push(`Asset missing pack_id: ${asset.asset_id}`);
      }
      if (!asset.file_path) {
        errors.push(`Asset missing file_path: ${asset.asset_id}`);
        continue;
      }
      const path = asset.file_path.startsWith("seo_content_os_scaffold_v4/")
        ? `${repoRoot}/${asset.file_path}`
        : asset.file_path;
      if (!(await fileExists(path))) {
        errors.push(`Asset file missing: ${asset.asset_id} -> ${asset.file_path}`);
      }
    }
  }

  for (const row of assets) {
    const status = (row.status || "").toLowerCase();
    if (status !== "active") {
      continue;
    }
    if (!row.file_path) {
      errors.push(`Asset missing file_path: ${row.asset_id}`);
      continue;
    }
    const path = row.file_path.startsWith("seo_content_os_scaffold_v4/")
      ? `${repoRoot}/${row.file_path}`
      : row.file_path;
    if (!(await fileExists(path))) {
      errors.push(`Asset file missing: ${row.asset_id} -> ${row.file_path}`);
    }
  }

  if (errors.length > 0) {
    console.error(`topic_lint.failed (${errors.length} errors)`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }

  console.log("topic_lint.ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { promises as fs } from "fs";
import { basename, dirname, join, relative } from "path";
import { readCsvRows, writeCsvRows } from "../core/src/utils/csv";
import { ensureDir, fileExists } from "../core/src/utils/fs";

type AssetRow = {
  asset_id: string;
  asset_type: string;
  scope: string;
  topic_id: string;
  pack_id: string;
  version: string;
  path: string;
  status: string;
  replaces_asset_id: string;
  created_at: string;
  last_reviewed_at: string;
  owner: string;
  notes: string;
};

const repoRoot = process.cwd();
const assetsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/assets/v1/assets_registry.csv`;

async function main() {
  const assets: AssetRow[] = [];
  const seen = new Set<string>();

  await addSchemas(assets, seen);
  await addConnectors(assets, seen);
  await addRules(assets, seen);
  await addPrompts(assets, seen);

  assets.sort((a, b) => {
    if (a.asset_type !== b.asset_type) {
      return a.asset_type.localeCompare(b.asset_type);
    }
    return a.asset_id.localeCompare(b.asset_id);
  });

  await writeCsvRows(
    assetsPath,
    [
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
    ],
    assets
  );
  console.log(`assets_registry.updated ${assetsPath} (${assets.length} assets)`);
}

async function addSchemas(assets: AssetRow[], seen: Set<string>) {
  const contractsDir = `${repoRoot}/seo_content_os_scaffold_v4/shared/contracts/v1`;
  if (!(await fileExists(contractsDir))) {
    return;
  }
  const files = await fs.readdir(contractsDir);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const id = `schema:${basename(file, ".json")}`;
    pushAsset(assets, seen, {
      asset_id: id,
      asset_type: "schema",
      scope: "shared",
      topic_id: "",
      pack_id: "contracts_v1",
      version: "v1",
      path: relPath(join(contractsDir, file)),
      status: "active",
      replaces_asset_id: "",
      created_at: "",
      last_reviewed_at: "",
      owner: "",
      notes: "",
    });
  }
}

async function addConnectors(assets: AssetRow[], seen: Set<string>) {
  const registryPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/connectors/v1/connectors_registry.csv`;
  if (!(await fileExists(registryPath))) {
    return;
  }
  const rows = await readCsvRows(registryPath);
  rows.forEach((row) => {
    const connectorId = row.connector_id || "";
    if (!connectorId) {
      return;
    }
    const id = `connector:${connectorId}`;
    pushAsset(assets, seen, {
      asset_id: id,
      asset_type: "connector",
      scope: "shared",
      topic_id: "",
      pack_id: "connectors_v1",
      version: "v1",
      path: relPath(registryPath),
      status: "active",
      replaces_asset_id: "",
      created_at: "",
      last_reviewed_at: "",
      owner: "",
      notes: "",
    });
  });
}

async function addRules(assets: AssetRow[], seen: Set<string>) {
  const rulepacksDir = `${repoRoot}/seo_content_os_scaffold_v4/shared/rulepacks/v1`;
  const files = await listFilesRecursive(rulepacksDir, (name) =>
    name.startsWith("15_validation_rules_registry")
  );
  for (const file of files) {
    const rows = await readCsvRows(file);
    const packId = inferPackId(file);
    rows.forEach((row) => {
      const ruleId = row.rule_id || "";
      if (!ruleId) {
        return;
      }
      const enabled = (row.enabled || "yes").toLowerCase() !== "no";
      if (!enabled) {
        return;
      }
      const id = `rule:${ruleId}`;
      pushAsset(assets, seen, {
        asset_id: id,
        asset_type: "rule",
        scope: "shared",
        topic_id: "",
        pack_id: packId,
        version: row.version || "v1",
        path: relPath(file),
        status: "active",
        replaces_asset_id: "",
        created_at: "",
        last_reviewed_at: "",
        owner: "",
        notes: "",
      });
    });
  }
}

async function addPrompts(assets: AssetRow[], seen: Set<string>) {
  const registryPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/promptpacks/v1/14_prompts_registry.csv`;
  if (!(await fileExists(registryPath))) {
    return;
  }
  const rows = await readCsvRows(registryPath);
  rows.forEach((row) => {
    const promptId = row.prompt_id || "";
    if (!promptId) {
      return;
    }
    const enabled = (row.enabled || "yes").toLowerCase() !== "no";
    if (!enabled) {
      return;
    }
    const id = `prompt:${promptId}`;
    pushAsset(assets, seen, {
      asset_id: id,
      asset_type: "prompt",
      scope: "shared",
      topic_id: "",
      pack_id: "promptpack_v1",
      version: row.version || "v1",
      path: relPath(registryPath),
      status: "active",
      replaces_asset_id: "",
      created_at: "",
      last_reviewed_at: "",
      owner: "",
      notes: "",
    });
  });
}

function pushAsset(assets: AssetRow[], seen: Set<string>, row: AssetRow) {
  if (seen.has(row.asset_id)) {
    return;
  }
  seen.add(row.asset_id);
  assets.push(row);
}

function relPath(path: string) {
  const rel = relative(repoRoot, path);
  return rel.startsWith("seo_content_os_scaffold_v4") ? rel : path;
}

function inferPackId(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/global/")) {
    return "rules_global_v1";
  }
  const pageTypeMatch = normalized.match(/rulepacks\/v1\/page_types\/([^/]+)/);
  if (pageTypeMatch) {
    return `rules_page_${pageTypeMatch[1]}_v1`;
  }
  const optionMatch = normalized.match(/rulepacks\/v1\/options\/([^/]+)/);
  if (optionMatch) {
    return `opt_${optionMatch[1]}_v1`;
  }
  return "unknown";
}

async function listFilesRecursive(root: string, filter: (name: string) => boolean): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath, filter)));
    } else if (entry.isFile() && filter(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { readCsvRows } from "../core/src/utils/csv";

const repoRoot = process.cwd();
const assetsPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/assets/v1/assets_registry.csv`;

async function main() {
  const query = process.argv[2];
  if (!query) {
    throw new Error("Usage: tools/asset_where.ts <dedupe_key|asset_id>");
  }

  const assets = await readCsvRows(assetsPath);
  const matches = assets.filter((row) => row.asset_id === query || row.dedupe_key === query);
  if (matches.length === 0) {
    console.log("asset_where.not_found");
    process.exit(1);
  }

  matches.forEach((row) => {
    console.log(
      `${row.asset_id} | ${row.asset_type} | ${row.pack_id} | ${row.file_path} | ${row.item_id}`
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

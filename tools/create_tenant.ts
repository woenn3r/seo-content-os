import { copyDir, fileExists, readFile, writeFile } from "../core/src/utils/fs";
import { logger } from "../core/src/utils/logger";
import { loadEnv } from "../core/src/utils/loadEnv";

loadEnv();

const args = process.argv.slice(2);
const domain = getArgValue(args, "--domain");
const siteState = getArgValue(args, "--site_state") || "";

if (!domain) {
  throw new Error("Missing --domain");
}

if (siteState && siteState !== "existing" && siteState !== "new") {
  throw new Error("--site_state must be existing|new");
}

const repoRoot = process.cwd();
const templatePath = `${repoRoot}/seo_content_os_scaffold_v4/tenants/_TEMPLATE_website`;
const tenantPath = `${repoRoot}/seo_content_os_scaffold_v4/tenants/${domain}`;

(async () => {
  if (await fileExists(tenantPath)) {
    throw new Error(`Tenant already exists: ${tenantPath}`);
  }

  await copyDir(templatePath, tenantPath);
  await setSiteState(tenantPath, siteState);

  logger.info("tenant.created", { tenantPath, siteState: siteState || "(empty)" });
})();

async function setSiteState(tenantPath: string, value: string): Promise<void> {
  const configPath = `${tenantPath}/data/01_project/project_config/v1/01_project_config.csv`;
  const raw = await readFile(configPath);
  const lines = raw.split(/\r?\n/);

  const updated = lines.map((line) => {
    if (!line.startsWith("site_state,")) {
      return line;
    }

    const notes = "\"existing|new\"";
    return `site_state,${value},${notes}`;
  });

  await writeFile(configPath, updated.join("\n"));
}

function getArgValue(argsList: string[], key: string): string | undefined {
  const index = argsList.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return argsList[index + 1];
}

import { readCsvKeyValue } from "../utils/csv";

export type TenantConfig = {
  tenantPath: string;
  siteState: string;
  allowExternalSources: boolean;
};

export async function loadTenantConfig(tenantPath: string): Promise<TenantConfig> {
  const projectConfigPath = `${tenantPath}/data/01_project/project_config/v1/01_project_config.csv`;
  const projectConfig = await readCsvKeyValue(projectConfigPath);

  return {
    tenantPath,
    siteState: projectConfig.site_state || "",
    allowExternalSources: (projectConfig.allow_external_sources || "").toLowerCase() === "yes",
  };
}

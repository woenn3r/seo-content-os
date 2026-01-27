import { readCsvKeyValue } from "../utils/csv";
export async function loadTenantConfig(tenantPath) {
    const projectConfigPath = `${tenantPath}/data/01_project/project_config/v1/01_project_config.csv`;
    const projectConfig = await readCsvKeyValue(projectConfigPath);
    return {
        tenantPath,
        siteState: projectConfig.site_state || "",
    };
}

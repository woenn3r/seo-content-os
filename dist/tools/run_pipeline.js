import { runPipeline } from "../core/src";
const args = process.argv.slice(2);
const tenantArg = getArgValue(args, "--tenant");
const profileId = getArgValue(args, "--profile");
const step = getArgValue(args, "--step");
if (!tenantArg || !profileId) {
    throw new Error("Usage: --tenant <domain|path> --profile <profile_id> [--step ingest|analyze|generate|qa|export]");
}
const repoRoot = process.cwd();
const tenantPath = tenantArg.includes("/")
    ? tenantArg
    : `${repoRoot}/seo_content_os_scaffold_v4/tenants/${tenantArg}`;
runPipeline({ tenantPath, profileId, repoRoot, step }).catch((error) => {
    console.error(error);
    process.exit(1);
});
function getArgValue(argsList, key) {
    const index = argsList.indexOf(key);
    if (index === -1) {
        return undefined;
    }
    return argsList[index + 1];
}

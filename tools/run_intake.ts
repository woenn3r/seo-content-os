import { runIntake } from "../core/src/pipelines/ingest/runIntake";
import { loadEnv } from "../core/src/utils/loadEnv";

loadEnv();

const args = process.argv.slice(2);
const tenantArg = getArgValue(args, "--tenant");
const profileId = getArgValue(args, "--profile");
const answersPath = getArgValue(args, "--answers");
const pageId = getArgValue(args, "--page_id");

if (!tenantArg || !profileId) {
  throw new Error(
    "Usage: --tenant <domain|path> --profile <profile_id> [--answers <path>] [--page_id <id>]"
  );
}

const repoRoot = process.cwd();
const tenantPath = tenantArg.includes("/")
  ? tenantArg
  : `${repoRoot}/seo_content_os_scaffold_v4/tenants/${tenantArg}`;

runIntake({ tenantPath, profileId, answersPath: answersPath || undefined, pageId: pageId || undefined }).catch(
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

function getArgValue(argsList: string[], key: string): string | undefined {
  const index = argsList.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return argsList[index + 1];
}

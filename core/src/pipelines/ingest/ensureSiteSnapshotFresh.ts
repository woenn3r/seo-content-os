import { RunProfile } from "../../config/loadRunProfile";
import { logger } from "../../utils/logger";
import { getSnapshotStatus, SnapshotStatus } from "../../utils/snapshot";
import { crawlSite } from "./crawlSite";

type Input = {
  tenantPath: string;
  siteState: string;
  runProfile: RunProfile;
};

export async function ensureSiteSnapshotFresh(input: Input): Promise<SnapshotStatus> {
  const status = await getSnapshotStatus(input.tenantPath, input.siteState, input.runProfile);
  if (status.isFresh) {
    logger.info("snapshot.fresh", { reason: status.reason, latest: status.latestExtractedAt });
    return status;
  }

  if (!status.required) {
    logger.info("snapshot.skip", { reason: status.reason });
    return status;
  }

  logger.info("snapshot.refresh", { reason: status.reason });
  await crawlSite({ tenantPath: input.tenantPath });
  const refreshed = await getSnapshotStatus(input.tenantPath, input.siteState, input.runProfile);
  if (!refreshed.isFresh) {
    logger.warn("snapshot.block", { reason: refreshed.reason });
  }
  return refreshed;
}

import { readJsonFile } from "../utils/fs";

export type RunProfile = {
  profile_id: string;
  mode?: string;
  languages?: string[];
  regions?: string[];
  blueprint_pack?: string;
  rule_packs?: string[];
  prompt_pack?: string;
  contracts_version?: string;
  blocking_policy?: Record<string, string>;
  require_site_snapshot?: boolean;
  snapshot_ttl_hours?: number;
  generator_model?: string;
  research_model?: string;
  retrieval_model?: string;
  max_iter?: number;
};

export async function loadRunProfile(tenantPath: string, profileId: string): Promise<RunProfile> {
  const path = `${tenantPath}/run_profiles/${profileId}.json`;
  return readJsonFile<RunProfile>(path);
}

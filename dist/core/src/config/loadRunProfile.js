import { readJsonFile } from "../utils/fs";
export async function loadRunProfile(tenantPath, profileId) {
    const path = `${tenantPath}/run_profiles/${profileId}.json`;
    return readJsonFile(path);
}

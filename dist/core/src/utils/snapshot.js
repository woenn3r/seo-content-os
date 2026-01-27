import { readCsvRows } from "./csv";
import { fileExists } from "./fs";
const SNAPSHOT_PATH = "data/02_ingest/site_content_snapshot/v1/07_site_content_snapshot.csv";
const CRAWL_SETTINGS_PATH = "data/02_ingest/crawl_settings/v1/07_crawl_settings.csv";
export async function getSnapshotStatus(tenantPath, siteState, runProfile) {
    const requireSnapshot = runProfile.require_site_snapshot === true;
    const state = siteState.toLowerCase();
    if (!requireSnapshot) {
        return { required: false, isFresh: true, reason: "require_site_snapshot=false" };
    }
    if (state !== "existing") {
        return { required: true, isFresh: true, reason: `site_state=${siteState || "(empty)"}` };
    }
    const snapshotPath = `${tenantPath}/${SNAPSHOT_PATH}`;
    if (!(await fileExists(snapshotPath))) {
        return { required: true, isFresh: false, reason: "snapshot_missing" };
    }
    const ttlHours = await readSnapshotTtlHours(tenantPath, runProfile.snapshot_ttl_hours);
    const rows = await readCsvRows(snapshotPath);
    const latest = rows
        .map((row) => row.extracted_at)
        .filter((value) => value)
        .map((value) => new Date(value))
        .filter((date) => !isNaN(date.getTime()))
        .sort((a, b) => b.getTime() - a.getTime())[0];
    if (!latest) {
        return { required: true, isFresh: false, reason: "no_extracted_at", ttlHours };
    }
    if (!ttlHours) {
        return {
            required: true,
            isFresh: true,
            reason: "ttl_not_set",
            latestExtractedAt: latest.toISOString(),
        };
    }
    const ageMs = Date.now() - latest.getTime();
    const maxAgeMs = ttlHours * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) {
        return {
            required: true,
            isFresh: false,
            reason: "snapshot_stale",
            latestExtractedAt: latest.toISOString(),
            ttlHours,
        };
    }
    return {
        required: true,
        isFresh: true,
        reason: "snapshot_fresh",
        latestExtractedAt: latest.toISOString(),
        ttlHours,
    };
}
async function readSnapshotTtlHours(tenantPath, fallback) {
    if (typeof fallback === "number") {
        return fallback;
    }
    const settingsPath = `${tenantPath}/${CRAWL_SETTINGS_PATH}`;
    if (!(await fileExists(settingsPath))) {
        return undefined;
    }
    const rows = await readCsvRows(settingsPath);
    if (rows.length === 0) {
        return undefined;
    }
    const value = rows[0].snapshot_ttl_hours;
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

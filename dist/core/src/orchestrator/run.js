import { loadRunProfile } from "../config/loadRunProfile";
import { loadTenantConfig } from "../config/loadTenantConfig";
import { resolvePacks } from "../config/resolvePacks";
import { ensureSiteSnapshotFresh } from "../pipelines/ingest/ensureSiteSnapshotFresh";
import { analyzeSiteContext } from "../pipelines/analyze/analyzeSiteContext";
import { generatePages } from "../pipelines/generate/generatePages";
import { validateOutputs } from "../pipelines/qa/validateOutputs";
import { exportPages } from "../pipelines/export/exportPages";
import { logger } from "../utils/logger";
import { ensureDir, writeFile } from "../utils/fs";
export async function runPipeline(input) {
    logger.info("pipeline.start", input);
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = `${input.repoRoot}/seo_content_os_scaffold_v4/runs/${runId}`;
    let snapshotStatus = null;
    const runProfile = await loadRunProfile(input.tenantPath, input.profileId);
    const tenantConfig = await loadTenantConfig(input.tenantPath);
    const resolvedPacks = await resolvePacks(input.repoRoot, input.tenantPath, runProfile, tenantConfig);
    logger.info("pipeline.config", {
        siteState: tenantConfig.siteState,
        packs: resolvedPacks.activePacks,
    });
    await persistResolvedConfig(runDir, runProfile, tenantConfig, resolvedPacks);
    if (!input.step || input.step === "ingest") {
        snapshotStatus = await ensureSiteSnapshotFresh({
            tenantPath: input.tenantPath,
            siteState: tenantConfig.siteState,
            runProfile,
        });
    }
    if (!input.step || input.step === "analyze") {
        await analyzeSiteContext({ tenantPath: input.tenantPath });
    }
    if (!input.step || input.step === "generate") {
        await generatePages({ tenantPath: input.tenantPath });
    }
    if (!input.step || input.step === "qa") {
        await validateOutputs({
            tenantPath: input.tenantPath,
            runProfile,
            siteState: tenantConfig.siteState,
            snapshotStatus: snapshotStatus || undefined,
        });
    }
    if (!input.step || input.step === "export") {
        await exportPages({
            tenantPath: input.tenantPath,
            runProfile,
            runId,
            runDir,
            resolvedPacks,
            siteState: tenantConfig.siteState,
            snapshotStatus: snapshotStatus || undefined,
        });
    }
    logger.info("pipeline.done", { tenantPath: input.tenantPath, profileId: input.profileId });
}
async function persistResolvedConfig(runDir, runProfile, tenantConfig, resolvedPacks) {
    const payload = {
        run_profile: runProfile,
        tenant_config: tenantConfig,
        resolved_packs: resolvedPacks.activePacks,
        matrix_rows_applied: resolvedPacks.matrixRowsApplied,
        matrix_matches: resolvedPacks.pageMatches,
        severity_overrides: resolvedPacks.severity_overrides,
        match_sorting: "less_specific_first; higher_specificity and later rows override",
        created_at: new Date().toISOString(),
    };
    const targetPath = `${runDir}/resolved_config.json`;
    await ensureDir(targetPath);
    await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

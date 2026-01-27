import { loadRunProfile } from "../config/loadRunProfile";
import { loadTenantConfig } from "../config/loadTenantConfig";
import { resolvePacks } from "../config/resolvePacks";
import { ensureSiteSnapshotFresh } from "../pipelines/ingest/ensureSiteSnapshotFresh";
import { analyzeSiteContext } from "../pipelines/analyze/analyzeSiteContext";
import { generatePages } from "../pipelines/generate/generatePages";
import { validateOutputs } from "../pipelines/qa/validateOutputs";
import { exportPages } from "../pipelines/export/exportPages";
import { logger } from "../utils/logger";
import { ensureDir, listFiles, readFile, writeFile } from "../utils/fs";
import { checkConnectors } from "../preflight/checkConnectors";

type RunPipelineInput = {
  tenantPath: string;
  profileId: string;
  repoRoot: string;
  step?: PipelineStep;
  runId?: string;
};

type PipelineStep = "ingest" | "analyze" | "generate" | "qa" | "export";

export async function runPipeline(input: RunPipelineInput): Promise<void> {
  logger.info("pipeline.start", input);
  const runId = input.runId || new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = `${input.repoRoot}/seo_content_os_scaffold_v4/runs/${runId}`;
  let snapshotStatus = null as null | { isFresh: boolean; reason: string };

  const runProfile = await loadRunProfile(input.tenantPath, input.profileId);
  const tenantConfig = await loadTenantConfig(input.tenantPath);
  const resolvedPacks = await resolvePacks(
    input.repoRoot,
    input.tenantPath,
    runProfile,
    tenantConfig
  );

  logger.info("pipeline.config", {
    siteState: tenantConfig.siteState,
    packs: resolvedPacks.activePacks,
  });

  await persistResolvedConfig(runDir, runProfile, tenantConfig, resolvedPacks);

  const preflight = await checkConnectors({
    repoRoot: input.repoRoot,
    tenantPath: input.tenantPath,
    runDir,
    runId,
    runProfile,
    resolvedPacks,
    step: input.step,
  });
  if (preflight.status === "BLOCK") {
    throw new Error(`Preflight blocked: ${preflight.reportPath}`);
  }

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

  const shouldIterate = !input.step && runProfile.mode === "perfect";

  if (!input.step || input.step === "generate") {
    if (shouldIterate) {
      await runIterativeGeneration({
        tenantPath: input.tenantPath,
        runProfile,
        tenantConfig,
        runDir,
        runId,
        resolvedPacks,
        snapshotStatus: snapshotStatus || undefined,
      });
    } else {
      await generatePages({
        tenantPath: input.tenantPath,
        runId,
        runDir,
        runProfile,
        tenantConfig,
      });
    }
  }

  if (!input.step || input.step === "qa") {
    if (!shouldIterate) {
      await validateOutputs({
        tenantPath: input.tenantPath,
        runProfile,
        siteState: tenantConfig.siteState,
        snapshotStatus: snapshotStatus || undefined,
        runDir,
        resolvedPacks,
      });
    }
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

async function runIterativeGeneration(input: {
  tenantPath: string;
  runProfile: typeof import("../config/loadRunProfile").RunProfile;
  tenantConfig: typeof import("../config/loadTenantConfig").TenantConfig;
  runDir: string;
  runId: string;
  resolvedPacks: {
    activePacks: string[];
    ruleFiles: string[];
    severity_overrides: Record<string, unknown>;
    pageMatches: Array<{ page_id: string; severity_overrides: Record<string, unknown> }>;
  };
  snapshotStatus?: { isFresh: boolean; reason: string };
}): Promise<void> {
  const maxIter = input.runProfile.max_iter || 3;
  let fixListByPage: Record<string, unknown[]> = {};

  for (let iteration = 1; iteration <= maxIter; iteration += 1) {
    await generatePages({
      tenantPath: input.tenantPath,
      runId: input.runId,
      runDir: input.runDir,
      runProfile: input.runProfile,
      tenantConfig: input.tenantConfig,
      iteration,
      fixListByPage,
    });

    await validateOutputs({
      tenantPath: input.tenantPath,
      runProfile: input.runProfile,
      siteState: input.tenantConfig.siteState,
      snapshotStatus: input.snapshotStatus || undefined,
      runDir: input.runDir,
      resolvedPacks: input.resolvedPacks,
    });

    const qaSummary = await collectQaSummary(input.tenantPath);
    if (qaSummary.allPass) {
      logger.info("iterate.pass", { iteration });
      return;
    }
    fixListByPage = qaSummary.fixListByPage;
    logger.info("iterate.retry", { iteration, remaining: maxIter - iteration });
  }
}

async function collectQaSummary(tenantPath: string): Promise<{
  allPass: boolean;
  fixListByPage: Record<string, unknown[]>;
}> {
  const outputDir = `${tenantPath}/data/04_generation/page_packages/v1`;
  let files: string[] = [];
  try {
    files = await listFiles(outputDir);
  } catch {
    return { allPass: true, fixListByPage: {} };
  }
  const fixListByPage: Record<string, unknown[]> = {};
  let allPass = true;

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const raw = await readFile(`${outputDir}/${file}`);
    const parsed = JSON.parse(raw) as { qa?: { status?: string; fix_list?: unknown[] } };
    const status = parsed.qa?.status || "UNKNOWN";
    const pageId = file.replace(/\.json$/, "");
    if (status !== "PASS") {
      allPass = false;
      fixListByPage[pageId] = parsed.qa?.fix_list || [];
    }
  }

  return { allPass, fixListByPage };
}

async function persistResolvedConfig(
  runDir: string,
  runProfile: unknown,
  tenantConfig: unknown,
  resolvedPacks: {
    activePacks: string[];
    matrixRowsApplied: number;
    pageMatches: Array<{ page_id: string; matches: unknown[]; severity_overrides: unknown }>;
    severity_overrides: Record<string, unknown>;
    ruleFiles: string[];
    rulesByPack: Record<string, { rule_file: string; enabled_rules: number }>;
    missingRuleFiles: Array<{ pack: string; reason: string }>;
  }
): Promise<void> {
  const repoRoot = process.cwd();
  const promptFiles = await resolvePromptFiles(runProfile as Record<string, unknown>, repoRoot);
  const schemaFiles = await resolveSchemaFiles(runProfile as Record<string, unknown>, repoRoot);
  const payload = {
    run_profile: runProfile,
    tenant_config: tenantConfig,
    resolved_packs: resolvedPacks.activePacks,
    matrix_rows_applied: resolvedPacks.matrixRowsApplied,
    matrix_matches: resolvedPacks.pageMatches,
    severity_overrides: resolvedPacks.severity_overrides,
    rule_files: resolvedPacks.ruleFiles,
    prompt_files: promptFiles,
    schema_files: schemaFiles,
    rules_by_pack: resolvedPacks.rulesByPack,
    missing_rule_files: resolvedPacks.missingRuleFiles,
    match_sorting: "less_specific_first; higher_specificity and later rows override",
    created_at: new Date().toISOString(),
  };

  const targetPath = `${runDir}/resolved_config.json`;
  await ensureDir(targetPath);
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function resolvePromptFiles(runProfile: Record<string, unknown>, repoRoot: string): Promise<string[]> {
  const promptPack = String(runProfile.prompt_pack || "").trim();
  if (!promptPack) {
    return [];
  }
  const basePath = resolveSharedPath(promptPack, repoRoot);
  if (!basePath) {
    return [];
  }
  try {
    const files = await listFiles(basePath);
    return files.map((file) => `${basePath}/${file}`);
  } catch {
    return [];
  }
}

async function resolveSchemaFiles(runProfile: Record<string, unknown>, repoRoot: string): Promise<string[]> {
  const contracts = String(runProfile.contracts_version || "").trim();
  if (!contracts) {
    return [];
  }
  const basePath = resolveSharedPath(contracts, repoRoot);
  if (!basePath) {
    return [];
  }
  try {
    const files = await listFiles(basePath);
    return files.filter((file) => file.endsWith(".json")).map((file) => `${basePath}/${file}`);
  } catch {
    return [];
  }
}

function resolveSharedPath(value: string, repoRoot: string): string | null {
  if (value.startsWith("shared/")) {
    return `${repoRoot}/seo_content_os_scaffold_v4/${value}`;
  }
  if (value.startsWith("seo_content_os_scaffold_v4/")) {
    return `${repoRoot}/${value}`;
  }
  return null;
}

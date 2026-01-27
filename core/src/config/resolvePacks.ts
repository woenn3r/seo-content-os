import { readCsvRows } from "../utils/csv";
import { RunProfile } from "./loadRunProfile";
import { TenantConfig } from "./loadTenantConfig";
import { logger } from "../utils/logger";
import { fileExists } from "../utils/fs";

type ResolvedPacks = {
  activePacks: string[];
  matrixRowsApplied: number;
  pageMatches: Array<{
    page_id: string;
    matches: Array<MatrixMatch>;
    severity_overrides: Record<string, unknown>;
  }>;
  severity_overrides: Record<string, unknown>;
  ruleFiles: string[];
  rulesByPack: Record<string, { rule_file: string; enabled_rules: number }>;
  missingRuleFiles: Array<{ pack: string; reason: string }>;
};

type MatrixMatch = {
  page_id: string;
  row_index: number;
  score: number;
  page_type: string;
  intent: string;
  language: string;
  region: string;
  enabled_packs: string[];
  severity_overrides: Record<string, unknown>;
};

export async function resolvePacks(
  repoRoot: string,
  tenantPath: string,
  runProfile: RunProfile,
  _tenantConfig: TenantConfig
): Promise<ResolvedPacks> {
  const matrixPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/activation/v1/pack_activation_matrix.csv`;
  const matrixRows = await readCsvRows(matrixPath);

  logger.info("packs.matrix.loaded", { rows: matrixRows.length });

  const pagespecPath = `${tenantPath}/data/03_strategy/pagespec/v1/11_pagespec.csv`;
  const pageSpecs = await readCsvRows(pagespecPath);

  const activePacks = new Set<string>(runProfile.rule_packs || []);
  let appliedCount = 0;
  const pageMatches: ResolvedPacks["pageMatches"] = [];
  const globalOverrides: Record<string, unknown> = {};

  for (const matrixRow of matrixRows) {
    const enabledPacks = parsePackList(matrixRow.enabled_packs);
    if (enabledPacks.length === 0) {
      continue;
    }

    if (pageSpecs.length === 0) {
      if (matchesRunProfile(matrixRow, runProfile)) {
        enabledPacks.forEach((pack) => activePacks.add(pack));
        appliedCount += 1;
        mergeOverrides(globalOverrides, parseOverrides(matrixRow.severity_overrides_json));
      }
      continue;
    }
  }

  for (const spec of pageSpecs) {
    if (!spec.page_id) {
      continue;
    }

    const matches: MatrixMatch[] = [];
    matrixRows.forEach((row, index) => {
      if (!matchesMatrixRow(row, spec)) {
        return;
      }
      const packs = parsePackList(row.enabled_packs);
      const overrides = parseOverrides(row.severity_overrides_json);
      matches.push({
        page_id: spec.page_id,
        row_index: index,
        score: specificityScore(row),
        page_type: row.page_type || "*",
        intent: row.intent || "*",
        language: row.language || "*",
        region: row.region || "*",
        enabled_packs: packs,
        severity_overrides: overrides,
      });
    });

    const ordered = sortMatches(matches);
    const appliedOverrides: Record<string, unknown> = {};

    ordered.forEach((match) => {
      match.enabled_packs.forEach((pack) => activePacks.add(pack));
      mergeOverrides(appliedOverrides, match.severity_overrides);
      appliedCount += 1;
    });

    pageMatches.push({
      page_id: spec.page_id,
      matches: ordered,
      severity_overrides: appliedOverrides,
    });

    mergeOverrides(globalOverrides, appliedOverrides);
  }

  const { ruleFiles, rulesByPack, missingRuleFiles } = await resolveRuleFiles(
    repoRoot,
    Array.from(activePacks)
  );

  return {
    activePacks: Array.from(activePacks),
    matrixRowsApplied: appliedCount,
    pageMatches,
    severity_overrides: globalOverrides,
    ruleFiles,
    rulesByPack,
    missingRuleFiles,
  };
}

function parsePackList(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(";")
    .map((pack) => pack.trim())
    .filter((pack) => pack.length > 0);
}

function matchesMatrixRow(row: Record<string, string>, spec: Record<string, string>): boolean {
  return (
    matchesValue(row.page_type, spec.page_type) &&
    matchesValue(row.intent, spec.intent) &&
    matchesListValue(row.language, spec.language) &&
    matchesValue(row.region, spec.region)
  );
}

function matchesValue(matrixValue?: string, specValue?: string): boolean {
  if (!matrixValue || matrixValue === "*") {
    return true;
  }
  return matrixValue === specValue;
}

function matchesListValue(matrixValue?: string, specValue?: string): boolean {
  if (!matrixValue || matrixValue === "*") {
    return true;
  }
  if (!specValue) {
    return false;
  }
  return matrixValue
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === specValue);
}

function matchesRunProfile(row: Record<string, string>, profile: RunProfile): boolean {
  const languages = profile.languages || [];
  const regions = profile.regions || [];
  if (!matchesValue(row.page_type, "*") || !matchesValue(row.intent, "*")) {
    return false;
  }
  if (row.language && row.language !== "*") {
    if (!languages.some((lang) => matchesListValue(row.language, lang))) {
      return false;
    }
  }
  if (row.region && row.region !== "*") {
    if (!regions.some((region) => matchesValue(row.region, region))) {
      return false;
    }
  }
  return true;
}

function specificityScore(row: Record<string, string>): number {
  const fields = ["page_type", "intent", "language", "region"];
  return fields.reduce((score, field) => {
    const value = row[field];
    if (!value || value === "*") {
      return score;
    }
    return score + 1;
  }, 0);
}

function sortMatches(matches: MatrixMatch[]): MatrixMatch[] {
  // Less specific first; higher specificity and later rows override.
  return [...matches].sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return a.row_index - b.row_index;
  });
}

function parseOverrides(value?: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mergeOverrides(target: Record<string, unknown>, incoming: Record<string, unknown>): void {
  Object.entries(incoming).forEach(([key, value]) => {
    target[key] = value;
  });
}

async function resolveRuleFiles(
  repoRoot: string,
  packs: string[]
): Promise<{
  ruleFiles: string[];
  rulesByPack: Record<string, { rule_file: string; enabled_rules: number }>;
  missingRuleFiles: Array<{ pack: string; reason: string }>;
}> {
  const ruleFiles: string[] = [];
  const ruleFileSet = new Set<string>();
  const rulesByPack: Record<string, { rule_file: string; enabled_rules: number }> = {};
  const missingRuleFiles: Array<{ pack: string; reason: string }> = [];

  for (const pack of packs) {
    const packPath = resolvePackPath(repoRoot, pack);
    if (!packPath) {
      missingRuleFiles.push({ pack, reason: "unknown_pack_id" });
      continue;
    }

    const globalRulesPath = `${packPath}/15_validation_rules_registry_global.csv`;
    const standardRulesPath = `${packPath}/15_validation_rules_registry.csv`;
    const ruleFile = (await fileExists(globalRulesPath))
      ? globalRulesPath
      : (await fileExists(standardRulesPath))
      ? standardRulesPath
      : null;

    if (!ruleFile) {
      missingRuleFiles.push({ pack, reason: "rule_file_not_found" });
      continue;
    }

    const rows = await readCsvRows(ruleFile);
    const enabledCount = rows.filter((row) => (row.enabled || "yes").toLowerCase() !== "no").length;
    if (!ruleFileSet.has(ruleFile)) {
      ruleFiles.push(ruleFile);
      ruleFileSet.add(ruleFile);
    }
    rulesByPack[pack] = { rule_file: ruleFile, enabled_rules: enabledCount };
  }

  return { ruleFiles, rulesByPack, missingRuleFiles };
}

function resolvePackPath(repoRoot: string, pack: string): string | null {
  if (pack.includes("/")) {
    if (pack.startsWith("seo_content_os_scaffold_v4/")) {
      return `${repoRoot}/${pack}`;
    }
    return `${repoRoot}/seo_content_os_scaffold_v4/${pack}`;
  }

  if (pack.startsWith("rules_global_")) {
    return `${repoRoot}/seo_content_os_scaffold_v4/shared/rulepacks/v1/global`;
  }

  if (pack.startsWith("rules_page_")) {
    const name = pack.replace(/^rules_page_/, "").replace(/_v\d+$/, "");
    return `${repoRoot}/seo_content_os_scaffold_v4/shared/rulepacks/v1/page_types/${name}`;
  }

  if (pack.startsWith("opt_")) {
    const name = pack.replace(/^opt_/, "").replace(/_v\d+$/, "");
    return `${repoRoot}/seo_content_os_scaffold_v4/shared/rulepacks/v1/options/${name}`;
  }

  return null;
}

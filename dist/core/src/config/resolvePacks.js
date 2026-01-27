import { readCsvRows } from "../utils/csv";
import { logger } from "../utils/logger";
export async function resolvePacks(repoRoot, tenantPath, runProfile, _tenantConfig) {
    const matrixPath = `${repoRoot}/seo_content_os_scaffold_v4/shared/activation/v1/pack_activation_matrix.csv`;
    const matrixRows = await readCsvRows(matrixPath);
    logger.info("packs.matrix.loaded", { rows: matrixRows.length });
    const pagespecPath = `${tenantPath}/data/03_strategy/pagespec/v1/11_pagespec.csv`;
    const pageSpecs = await readCsvRows(pagespecPath);
    const activePacks = new Set(runProfile.rule_packs || []);
    let appliedCount = 0;
    const pageMatches = [];
    const globalOverrides = {};
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
        const matches = [];
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
        const appliedOverrides = {};
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
    return {
        activePacks: Array.from(activePacks),
        matrixRowsApplied: appliedCount,
        pageMatches,
        severity_overrides: globalOverrides,
    };
}
function parsePackList(value) {
    if (!value) {
        return [];
    }
    return value
        .split(";")
        .map((pack) => pack.trim())
        .filter((pack) => pack.length > 0);
}
function matchesMatrixRow(row, spec) {
    return (matchesValue(row.page_type, spec.page_type) &&
        matchesValue(row.intent, spec.intent) &&
        matchesListValue(row.language, spec.language) &&
        matchesValue(row.region, spec.region));
}
function matchesValue(matrixValue, specValue) {
    if (!matrixValue || matrixValue === "*") {
        return true;
    }
    return matrixValue === specValue;
}
function matchesListValue(matrixValue, specValue) {
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
function matchesRunProfile(row, profile) {
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
function specificityScore(row) {
    const fields = ["page_type", "intent", "language", "region"];
    return fields.reduce((score, field) => {
        const value = row[field];
        if (!value || value === "*") {
            return score;
        }
        return score + 1;
    }, 0);
}
function sortMatches(matches) {
    // Less specific first; higher specificity and later rows override.
    return [...matches].sort((a, b) => {
        if (a.score !== b.score) {
            return a.score - b.score;
        }
        return a.row_index - b.row_index;
    });
}
function parseOverrides(value) {
    if (!value) {
        return {};
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return {};
    }
}
function mergeOverrides(target, incoming) {
    Object.entries(incoming).forEach(([key, value]) => {
        target[key] = value;
    });
}

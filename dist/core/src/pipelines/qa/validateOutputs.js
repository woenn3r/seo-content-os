import Ajv from "ajv";
import { readCsvRows } from "../../utils/csv";
import { listFiles, readFile, readJsonFile, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { getSnapshotStatus } from "../../utils/snapshot";
const OUTPUT_DIR = "data/04_generation/page_packages/v1";
const PAGESPEC_PATH = "data/03_strategy/pagespec/v1/11_pagespec.csv";
const PAGEPACKAGE_SCHEMA = "seo_content_os_scaffold_v4/shared/contracts/v1/pagepackage.schema.json";
const PAGESPEC_SCHEMA = "seo_content_os_scaffold_v4/shared/contracts/v1/pagespec.schema.json";
export async function validateOutputs(input) {
    logger.info("validate.start", { tenantPath: input.tenantPath, mode: input.runProfile.mode });
    const repoRoot = process.cwd();
    const ajv = new Ajv({ allErrors: true, strict: false });
    const pagePackageSchema = await readJsonFile(`${repoRoot}/${PAGEPACKAGE_SCHEMA}`);
    const pageSpecSchema = await readJsonFile(`${repoRoot}/${PAGESPEC_SCHEMA}`);
    const validatePagePackage = ajv.compile(pagePackageSchema);
    const validatePageSpec = ajv.compile(pageSpecSchema);
    const parsingRules = await readJsonFile(`${repoRoot}/seo_content_os_scaffold_v4/shared/contracts/v1/csv_field_parsing_rules.json`);
    await validatePageSpecs(input.tenantPath, validatePageSpec, parsingRules);
    const dirPath = `${input.tenantPath}/${OUTPUT_DIR}`;
    let files = [];
    try {
        files = await listFiles(dirPath);
    }
    catch {
        logger.warn("validate.missing", { dirPath });
        return;
    }
    const snapshotStatus = input.snapshotStatus || (await getSnapshotStatus(input.tenantPath, input.siteState, input.runProfile));
    const snapshotGateBlocked = !snapshotStatus.isFresh ? snapshotStatus.reason : null;
    for (const file of files.filter((name) => name.endsWith(".json"))) {
        const raw = await readFile(`${dirPath}/${file}`);
        const parsed = JSON.parse(raw);
        const valid = validatePagePackage(parsed);
        if (!valid) {
            parsed.qa = buildQaBlock(parsed.qa, "PAGEPACKAGE_SCHEMA_INVALID", validatePagePackage.errors);
            await writeFile(`${dirPath}/${file}`, `${JSON.stringify(parsed, null, 2)}\n`);
            logger.error("validate.fail", { file, errors: validatePagePackage.errors });
            continue;
        }
        if (snapshotGateBlocked) {
            parsed.qa = buildQaBlock(parsed.qa, "REQUIRE_SITE_SNAPSHOT_FOR_EXISTING_SITE", [
                { message: `Site snapshot required: ${snapshotGateBlocked}` },
            ]);
            await writeFile(`${dirPath}/${file}`, `${JSON.stringify(parsed, null, 2)}\n`);
            logger.error("validate.block", { file, reason: snapshotGateBlocked });
            continue;
        }
        logger.info("validate.pass", { file });
    }
    logger.info("validate.done", { tenantPath: input.tenantPath });
}
async function validatePageSpecs(tenantPath, validator, parsingRules) {
    const rows = await readCsvRows(`${tenantPath}/${PAGESPEC_PATH}`);
    for (const row of rows) {
        if (!row.page_id) {
            continue;
        }
        const payload = coercePageSpec(row, parsingRules || {});
        const valid = validator(payload);
        if (!valid) {
            logger.error("validate.pagespec.fail", { page_id: row.page_id, errors: validator.errors });
            continue;
        }
        logger.info("validate.pagespec.pass", { page_id: row.page_id });
    }
}
function coercePageSpec(row, parsingRules) {
    const payload = {
        page_id: row.page_id,
        target_url: row.target_url,
        page_type: row.page_type,
        language: row.language,
        region: row.region,
        primary_keyword: row.primary_keyword,
        intent: row.intent,
        offer_id: row.offer_id,
    };
    for (const [field, rule] of Object.entries(parsingRules)) {
        const value = row[field];
        if (!value && !rule.allow_empty) {
            continue;
        }
        if (rule.type === "array") {
            const delimiter = rule.delimiter ?? ",";
            const normalized = value ? value.replace(/\\n/g, "\n") : "";
            const items = normalized
                ? normalized.split(delimiter).map((item) => (rule.trim ? item.trim() : item))
                : [];
            const cleaned = rule.allow_empty ? items : items.filter(Boolean);
            if (cleaned.length > 0 || rule.allow_empty) {
                payload[field] = cleaned;
            }
            continue;
        }
        if (value || rule.allow_empty) {
            payload[field] = value;
        }
    }
    return payload;
}
function buildQaBlock(current, ruleId, details) {
    const base = current || {
        status: "PASS",
        fail_rules: [],
        warn_rules: [],
        fix_list: [],
        completeness_score: 100,
        assumptions: [],
    };
    return {
        ...base,
        status: "BLOCK",
        fail_rules: Array.from(new Set([...(base.fail_rules || []), ruleId])),
        fix_list: [...(base.fix_list || []), { rule_id: ruleId, details }],
    };
}

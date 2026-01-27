import Ajv2020 from "ajv/dist/2020";
import { RunProfile } from "../../config/loadRunProfile";
import { readCsvKeyValue, readCsvRows } from "../../utils/csv";
import { ensureDir, fileExists, listFiles, readFile, readJsonFile, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { loadParsingRules, parseCsvFields } from "../../utils/parseCsvFields";
import { getSnapshotStatus } from "../../utils/snapshot";

const OUTPUT_DIR = "data/04_generation/page_packages/v1";
const PAGESPEC_PATH = "data/03_strategy/pagespec/v1/11_pagespec.csv";
const DUPLICATE_PATH = "data/03_strategy/analysis_outputs/v1/duplicate_content_report.csv";
const CANNIBAL_PATH = "data/03_strategy/analysis_outputs/v1/keyword_cannibalization_report.csv";
const PAGEPACKAGE_SCHEMA =
  "seo_content_os_scaffold_v4/shared/contracts/v1/pagepackage.schema.json";
const PAGESPEC_SCHEMA =
  "seo_content_os_scaffold_v4/shared/contracts/v1/pagespec.schema.json";

type Input = {
  tenantPath: string;
  runProfile: RunProfile;
  siteState: string;
  runDir: string;
  resolvedPacks: {
    activePacks: string[];
    ruleFiles: string[];
    severity_overrides: Record<string, unknown>;
    pageMatches: Array<{ page_id: string; severity_overrides: Record<string, unknown> }>;
  };
  snapshotStatus?: { isFresh: boolean; reason: string };
};

type RuleDefinition = {
  rule_id: string;
  severity: string;
  scope?: string;
  applies_to?: string;
  page_types?: string;
  languages?: string;
  intents?: string;
  check_name: string;
  params_json?: string;
  message?: string;
  fix_instructions?: string;
  enabled?: string;
};

type RuleResult = {
  rule_id: string;
  status: "pass" | "warn" | "fail" | "block" | "missing_data" | "not_applicable";
  severity: string;
  message?: string;
  fix_instructions?: string;
  evidence?: Record<string, unknown>;
  reason?: string;
};

export async function validateOutputs(input: Input): Promise<void> {
  logger.info("validate.start", { tenantPath: input.tenantPath, mode: input.runProfile.mode });
  const repoRoot = process.cwd();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const pagePackageSchema = await readJsonFile<Record<string, unknown>>(`${repoRoot}/${PAGEPACKAGE_SCHEMA}`);
  const pageSpecSchema = await readJsonFile<Record<string, unknown>>(`${repoRoot}/${PAGESPEC_SCHEMA}`);
  const validatePagePackage = ajv.compile(pagePackageSchema);
  const validatePageSpec = ajv.compile(pageSpecSchema);
  const parsingRules = await loadParsingRules(repoRoot);
  const pageSpecAllowedFields = Object.keys(
    (pageSpecSchema as { properties?: Record<string, unknown> }).properties || {}
  );

  const pageSpecs = await loadPageSpecs(
    input.tenantPath,
    parsingRules,
    validatePageSpec,
    pageSpecAllowedFields
  );
  const duplicateReport = await readCsvRows(`${input.tenantPath}/${DUPLICATE_PATH}`);
  const cannibalReport = await readCsvRows(`${input.tenantPath}/${CANNIBAL_PATH}`);
  const projectConfig = await readCsvKeyValue(
    `${input.tenantPath}/data/01_project/project_config/v1/01_project_config.csv`
  );
  const rules = await loadRules(input.resolvedPacks.ruleFiles);
  const preflight = await loadPreflightReport(input.runDir, input.tenantPath);
  const allowMissingData = preflight?.allow_missing_data === true;

  const dirPath = `${input.tenantPath}/${OUTPUT_DIR}`;
  let files: string[] = [];

  try {
    files = await listFiles(dirPath);
  } catch {
    logger.warn("validate.missing", { dirPath });
    return;
  }

  const snapshotStatus =
    input.snapshotStatus || (await getSnapshotStatus(input.tenantPath, input.siteState, input.runProfile));

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const raw = await readFile(`${dirPath}/${file}`);
    const parsed = JSON.parse(raw) as Record<string, any>;
    const pageId = file.replace(/\.json$/, "");

    const schemaValid = validatePagePackage(parsed);
    if (!schemaValid) {
      parsed.qa = buildQaBlock(parsed.qa, "PAGEPACKAGE_SCHEMA_INVALID", validatePagePackage.errors);
      await writeFile(`${dirPath}/${file}`, `${JSON.stringify(parsed, null, 2)}\n`);
      logger.error("validate.fail", { file, errors: validatePagePackage.errors });
      continue;
    }

    const pageSpec = pageSpecs[pageId];
    const pageSpecErrors = pageSpec?.validationErrors;
    const pageOverrides = input.resolvedPacks.pageMatches.find((entry) => entry.page_id === pageId);
    const severityOverrides = mergeSeverityOverrides(
      {
        ...input.resolvedPacks.severity_overrides,
        ...(pageOverrides?.severity_overrides || {}),
      },
      buildModeSeverityOverrides(input.runProfile.mode, input.siteState)
    );

    const ruleResults = rules.map((rule) => {
      if (!isRuleApplicable(rule, pageSpec?.data)) {
        return {
          rule_id: rule.rule_id,
          status: "not_applicable" as const,
          severity: (rule.severity || "warn").toLowerCase(),
          reason: "not_applicable",
        };
      }

      return evaluateRule(rule, {
        pageSpec: pageSpec?.data,
        pagePackage: parsed,
        duplicateReport,
        cannibalReport,
        severityOverrides,
        snapshotStatus,
        baseDomain: projectConfig.base_domain,
        urlLanguageStrategy: projectConfig.url_language_strategy,
      });
    });

    const normalizedResults = applyMissingDataPolicy(ruleResults, allowMissingData);
    const checksLog = buildChecksLog(pageId, rules, normalizedResults);
    await writeChecksLog(input.runDir, input.tenantPath, pageId, pageSpec?.data?.language, checksLog);

    const qa = buildQaSummary(parsed.qa, normalizedResults, allowMissingData);

    if (!pageSpec || pageSpecErrors) {
      qa.status = "BLOCK";
      qa.fail_rules = Array.from(new Set([...(qa.fail_rules || []), "PAGESPEC_SCHEMA_INVALID"]));
      qa.fix_list = [
        ...(qa.fix_list || []),
        {
          rule_id: "PAGESPEC_SCHEMA_INVALID",
          message: "PageSpec missing required fields.",
          evidence: pageSpecErrors,
        },
      ];
    }

    if (!snapshotStatus.isFresh) {
      qa.status = "BLOCK";
      qa.fail_rules = Array.from(
        new Set([...(qa.fail_rules || []), "REQUIRE_SITE_SNAPSHOT_FOR_EXISTING_SITE"])
      );
      qa.fix_list = [
        ...(qa.fix_list || []),
        {
          rule_id: "REQUIRE_SITE_SNAPSHOT_FOR_EXISTING_SITE",
          message: `Site snapshot required: ${snapshotStatus.reason}`,
          evidence: { reason: snapshotStatus.reason },
        },
      ];
    }

    parsed.qa = qa;
    await writeFile(`${dirPath}/${file}`, `${JSON.stringify(parsed, null, 2)}\n`);
    logger.info("validate.page.done", { file, status: qa.status });
  }

  logger.info("validate.done", { tenantPath: input.tenantPath });
}

async function loadPageSpecs(
  tenantPath: string,
  parsingRules: Record<string, unknown>,
  validator: (data: unknown) => boolean,
  allowedFields: string[]
): Promise<Record<string, { data: Record<string, any>; validationErrors?: unknown }>> {
  const rows = await readCsvRows(`${tenantPath}/${PAGESPEC_PATH}`);
  const specs: Record<string, { data: Record<string, any>; validationErrors?: unknown }> = {};

  for (const row of rows) {
    if (!row.page_id) {
      continue;
    }

    const parsed = parseCsvFields(row, parsingRules as any) as Record<string, any>;
    const payload: Record<string, any> = {};
    allowedFields.forEach((field) => {
      if (parsed[field] !== undefined) {
        payload[field] = parsed[field];
      }
    });
    const valid = validator(payload);
    specs[row.page_id] = {
      data: payload,
      validationErrors: valid ? undefined : validator.errors,
    };
    if (!valid) {
      logger.error("validate.pagespec.fail", { page_id: row.page_id, errors: validator.errors });
    } else {
      logger.info("validate.pagespec.pass", { page_id: row.page_id });
    }
  }

  return specs;
}

async function loadRules(ruleFiles: string[]): Promise<RuleDefinition[]> {
  const rules: RuleDefinition[] = [];
  for (const ruleFile of ruleFiles) {
    const rows = await readCsvRows(ruleFile);
    rows.forEach((row) => {
      if (!row.rule_id) {
        return;
      }
      const enabled = (row.enabled || "yes").toLowerCase() !== "no";
      if (!enabled) {
        return;
      }
      rules.push(row as RuleDefinition);
    });
  }
  return rules;
}

function isRuleApplicable(rule: RuleDefinition, pageSpec?: Record<string, any>): boolean {
  if (!pageSpec) {
    return false;
  }
  if (!matches(rule.page_types, pageSpec.page_type)) {
    return false;
  }
  if (!matches(rule.languages, pageSpec.language)) {
    return false;
  }
  if (!matches(rule.intents, pageSpec.intent)) {
    return false;
  }
  return true;
}

function matches(value?: string, target?: string): boolean {
  if (!value || value === "*") {
    return true;
  }
  if (!target) {
    return false;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === target);
}

function evaluateRule(
  rule: RuleDefinition,
  context: {
    pageSpec?: Record<string, any>;
    pagePackage: Record<string, any>;
    duplicateReport: Record<string, string>[];
    cannibalReport: Record<string, string>[];
    severityOverrides: Record<string, unknown>;
    snapshotStatus: { isFresh: boolean; reason: string };
    baseDomain?: string;
    urlLanguageStrategy?: string;
  }
): RuleResult {
  const params = parseParams(rule.params_json);
  const baseSeverity = (rule.severity || "warn").toLowerCase();
  const severity = applySeverityOverrides(rule.rule_id, baseSeverity, context.severityOverrides);
  const data = {
    title: context.pagePackage.meta?.title,
    description: context.pagePackage.meta?.description,
    slug: context.pagePackage.url?.slug,
    h1: context.pagePackage.content?.h1,
    body: context.pagePackage.content?.body,
    sections: context.pagePackage.content?.sections,
    faq: context.pagePackage.content?.faq,
    images: context.pagePackage.content?.images,
    outboundLinks: context.pagePackage.internal_links?.outbound || [],
    inboundSuggestions: context.pagePackage.internal_links?.inbound_suggestions || [],
    schemaJsonld: context.pagePackage.schema?.jsonld,
    primaryKeyword: context.pageSpec?.primary_keyword,
    targetUrl: context.pageSpec?.target_url,
    pageType: context.pageSpec?.page_type,
    baseDomain: context.baseDomain,
    urlLanguageStrategy: context.urlLanguageStrategy,
    language: context.pageSpec?.language,
  };

  const result = runCheck(
    rule.check_name,
    data,
    params,
    context.duplicateReport,
    context.cannibalReport,
    context.snapshotStatus
  );
  const statusMessage =
    result.status === "pass" || result.status === "not_applicable" ? undefined : result.message || rule.message;
  return {
    rule_id: rule.rule_id,
    status: result.status,
    severity,
    message: statusMessage,
    fix_instructions: rule.fix_instructions,
    evidence: result.evidence,
    reason: result.reason,
  };
}

function runCheck(
  checkName: string,
  data: Record<string, any>,
  params: Record<string, any>,
  duplicateReport: Record<string, string>[],
  cannibalReport: Record<string, string>[],
  snapshotStatus?: { isFresh: boolean; reason: string }
): { status: RuleResult["status"]; message?: string; evidence?: Record<string, unknown>; reason?: string } {
  switch (checkName) {
    case "require_site_snapshot":
      return checkRequireSnapshot(snapshotStatus);
    case "title_length":
      return checkLength("title", data.title, params.min, params.max);
    case "title_includes_primary_keyword":
      return checkIncludesKeyword("title", data.title, data.primaryKeyword);
    case "meta_description_length":
      return checkLength("meta_description", data.description, params.min, params.max);
    case "meta_description_includes_primary_keyword":
      return checkIncludesKeyword("meta_description", data.description, data.primaryKeyword);
    case "slug_format":
      return checkSlugFormat(data.slug, params.max_length || 80);
    case "slug_includes_primary_keyword":
      return checkSlugIncludesKeyword(data.slug, data.primaryKeyword);
    case "h1_present":
      return checkPresence("h1", data.h1);
    case "h1_single":
      return checkSingleH1(data.h1);
    case "h1_includes_primary_keyword":
      return checkIncludesKeyword("h1", data.h1, data.primaryKeyword);
    case "keyword_stuffing":
      return checkKeywordStuffing(data.body, data.primaryKeyword, params.max_density || 0.03, params);
    case "sections_heading_present":
      return checkSectionsHeadingPresent(data.sections);
    case "faq_items_complete":
      return checkFaqItemsComplete(data.faq);
    case "images_alt_present":
      return checkImagesAltPresent(data.images);
    case "outbound_links_no_empty":
      return checkOutboundLinksNoEmpty(data.outboundLinks);
    case "outbound_links_no_external":
      return checkOutboundLinksNoExternal(data.outboundLinks, data.baseDomain);
    case "contact_link_present":
      return checkContactLinkPresent(data.outboundLinks, data.pageType, params.contact_paths || []);
    case "internal_link_source_context_format":
      return checkInternalLinkSourceContextFormat(data.outboundLinks);
    case "section_link_source_context_match":
      return checkSectionLinkSourceContextMatch(data.outboundLinks, data.sections);
    case "contact_link_canonicalized":
      return checkContactLinkCanonicalized(
        data.outboundLinks,
        data.baseDomain,
        data.language,
        data.urlLanguageStrategy
      );
    case "internal_links_min_outbound":
      return checkMinOutboundLinks(data.outboundLinks, params.min || 2);
    case "schema_jsonld_present":
      return checkSchemaJsonld(data.schemaJsonld);
    case "duplicate_content_risk":
      return checkDuplicateRisk(data.targetUrl, duplicateReport, params.min_similarity || 0.85);
    case "cannibalization_conflict":
      return checkCannibalization(data.targetUrl, data.primaryKeyword, cannibalReport);
    case "anti_ai_banned_phrases":
      return checkBannedPhrases(data.body, data.h1, params.phrases || []);
    case "anti_ai_fluff_markers":
      return checkBannedPhrases(data.body, data.h1, params.markers || []);
    default:
      return { status: "missing_data", reason: "unknown_check" };
  }
}

function checkLength(label: string, value: string | undefined, min: number, max: number) {
  if (!value) {
    return missingData(label);
  }
  const length = value.trim().length;
  if (length < min || length > max) {
    return {
      status: "fail",
      message: `${label} length ${length} outside ${min}-${max}.`,
      evidence: { length, min, max },
    };
  }
  return { status: "pass", evidence: { length } };
}

function checkIncludesKeyword(label: string, value: string | undefined, keyword: string | undefined) {
  if (!value || !keyword) {
    return missingData(label);
  }
  const normalized = value.toLowerCase();
  const key = keyword.toLowerCase();
  if (!normalized.includes(key)) {
    return {
      status: "fail",
      message: `${label} missing primary keyword.`,
      evidence: { keyword },
    };
  }
  return { status: "pass" };
}

function checkSlugFormat(slug: string | undefined, maxLength: number) {
  if (!slug) {
    return missingData("slug");
  }
  const normalized = slug.trim();
  const valid = /^[a-z0-9/-]+$/.test(normalized) && !normalized.includes("//");
  if (!valid || normalized.length > maxLength) {
    return {
      status: "fail",
      message: "Slug format invalid.",
      evidence: { slug: normalized, maxLength },
    };
  }
  return { status: "pass" };
}

function checkSlugIncludesKeyword(slug: string | undefined, keyword: string | undefined) {
  if (!slug || !keyword) {
    return missingData("slug");
  }
  const normalizedSlug = slug.toLowerCase();
  const normalizedKeyword = keyword.toLowerCase().replace(/\s+/g, "-");
  if (!normalizedSlug.includes(normalizedKeyword)) {
    return {
      status: "fail",
      message: "Slug missing primary keyword.",
      evidence: { keyword, slug },
    };
  }
  return { status: "pass" };
}

function checkPresence(label: string, value: string | undefined) {
  if (!value) {
    return missingData(label);
  }
  return { status: "pass" };
}

function checkSingleH1(h1: string | undefined) {
  if (!h1) {
    return missingData("h1");
  }
  if (h1.includes("||") || h1.includes("\n")) {
    return {
      status: "fail",
      message: "Multiple H1 detected.",
      evidence: { h1 },
    };
  }
  return { status: "pass" };
}

function checkKeywordStuffing(
  body: string | undefined,
  keyword: string | undefined,
  maxDensity: number,
  params?: Record<string, any>
) {
  if (!body || !keyword) {
    return missingData("body");
  }
  const trimmed = body.trim();
  const minChars = Number(params?.min_body_chars || 300);
  const markers = Array.isArray(params?.stub_markers)
    ? params?.stub_markers
    : ["...", "stub content"];
  if (trimmed.length < minChars || markers.some((marker: string) => trimmed.toLowerCase().includes(marker))) {
    return {
      status: "not_applicable" as const,
      reason: "stub_content",
      evidence: { length: trimmed.length, min_body_chars: minChars },
    };
  }
  const text = body.toLowerCase();
  const key = keyword.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return missingData("body");
  }
  const occurrences = text.split(key).length - 1;
  const density = occurrences / words.length;
  const warnDensity = Number(params?.warn_density);
  const blockDensity = Number(params?.block_density);
  if (!Number.isNaN(blockDensity) && blockDensity > 0 && density > blockDensity) {
    return {
      status: "block" as const,
      message: "Keyword density too high.",
      evidence: { occurrences, word_count: words.length, density, blockDensity },
    };
  }
  if (!Number.isNaN(warnDensity) && warnDensity > 0 && density > warnDensity) {
    return {
      status: "warn" as const,
      message: "Keyword density too high.",
      evidence: { occurrences, word_count: words.length, density, warnDensity },
    };
  }
  if (density > maxDensity) {
    return {
      status: "warn" as const,
      message: "Keyword density too high.",
      evidence: { occurrences, word_count: words.length, density, maxDensity },
    };
  }
  return { status: "pass", evidence: { density } };
}

function checkMinOutboundLinks(outboundLinks: any[], min: number) {
  if (!outboundLinks) {
    return missingData("internal_links");
  }
  const count = Array.isArray(outboundLinks) ? outboundLinks.length : 0;
  if (count < min) {
    return {
      status: "warn",
      message: "Not enough outbound internal links.",
      evidence: { count, min },
    };
  }
  return { status: "pass", evidence: { count } };
}

function checkSchemaJsonld(schemaJsonld: string | undefined) {
  if (!schemaJsonld) {
    return {
      status: "fail",
      message: "Schema JSON-LD missing.",
    };
  }
  return { status: "pass" };
}

function checkSectionsHeadingPresent(sections: any) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return missingData("sections");
  }
  const missing = sections.filter((section) => !section || !String(section.heading || "").trim());
  if (missing.length > 0) {
    return {
      status: "fail" as const,
      message: "Section heading missing.",
      evidence: { missing_count: missing.length, total: sections.length },
    };
  }
  return { status: "pass" as const };
}

function checkFaqItemsComplete(faq: any) {
  if (!Array.isArray(faq) || faq.length === 0) {
    return notApplicable("faq");
  }
  const incomplete = faq.filter(
    (item) => !item || !String(item.question || "").trim() || !String(item.answer || "").trim()
  );
  if (incomplete.length > 0) {
    return {
      status: "warn" as const,
      message: "FAQ items missing question or answer.",
      evidence: { missing_count: incomplete.length, total: faq.length },
    };
  }
  return { status: "pass" as const };
}

function checkImagesAltPresent(images: any) {
  if (!Array.isArray(images) || images.length === 0) {
    return notApplicable("images");
  }
  const missing = images.filter((img) => !img || !String(img.alt || "").trim());
  if (missing.length > 0) {
    return {
      status: "warn" as const,
      message: "Image alt text missing.",
      evidence: { missing_count: missing.length, total: images.length },
    };
  }
  return { status: "pass" as const };
}

function checkOutboundLinksNoEmpty(outboundLinks: any[]) {
  if (!outboundLinks) {
    return missingData("internal_links");
  }
  const invalid = (Array.isArray(outboundLinks) ? outboundLinks : []).filter(
    (link) =>
      !link ||
      !String(link.label || "").trim() ||
      !String(link.url || "").trim() ||
      !String(link.type || "").trim()
  );
  if (invalid.length > 0) {
    return {
      status: "fail" as const,
      message: "Outbound internal links missing required fields.",
      evidence: { missing_count: invalid.length, total: outboundLinks.length },
    };
  }
  return { status: "pass" as const };
}

function checkOutboundLinksNoExternal(outboundLinks: any[], baseDomain?: string) {
  if (!outboundLinks) {
    return missingData("internal_links");
  }
  const normalizedBase = (baseDomain || "").replace(/^https?:\/\//, "").replace(/^www\./, "");
  const external = (Array.isArray(outboundLinks) ? outboundLinks : []).filter((link) => {
    const url = String(link?.url || "").toLowerCase();
    if (!url) {
      return false;
    }
    if (url.startsWith("/")) {
      return false;
    }
    if (url.startsWith("http")) {
      return normalizedBase ? !url.includes(normalizedBase) : true;
    }
    return false;
  });
  if (external.length > 0) {
    return {
      status: "fail" as const,
      message: "Outbound internal links include external URLs.",
      evidence: { count: external.length },
    };
  }
  return { status: "pass" as const };
}

function checkContactLinkPresent(outboundLinks: any[], pageType?: string, contactPaths?: string[]) {
  if (pageType !== "service_page") {
    return notApplicable("page_type");
  }
  if (!outboundLinks) {
    return missingData("internal_links");
  }
  const paths = Array.isArray(contactPaths) && contactPaths.length > 0 ? contactPaths : ["/kontakt", "/contact"];
  const found = (Array.isArray(outboundLinks) ? outboundLinks : []).some((link) => {
    const url = String(link?.url || "").toLowerCase();
    return paths.some((path) => url.includes(path));
  });
  if (!found) {
    return {
      status: "warn" as const,
      message: "Contact link missing from outbound internal links.",
      evidence: { expected_paths: paths },
    };
  }
  return { status: "pass" as const };
}

function checkInternalLinkSourceContextFormat(outboundLinks: any[]) {
  if (!outboundLinks) {
    return missingData("internal_links");
  }
  const pattern = /^(section:[a-z0-9_-]+|cta:(top|inline|bottom|footer)|body|faq:\d+)$/;
  const invalid = (Array.isArray(outboundLinks) ? outboundLinks : []).filter((link) => {
    const value = String(link?.source_context || "");
    return !pattern.test(value);
  });
  if (invalid.length > 0) {
    return {
      status: "fail" as const,
      message: "Outbound link source_context format invalid.",
      evidence: { invalid_count: invalid.length },
    };
  }
  return { status: "pass" as const };
}

function checkSectionLinkSourceContextMatch(outboundLinks: any[], sections: any) {
  if (!outboundLinks) {
    return missingData("internal_links");
  }
  const sectionIds = new Set(
    Array.isArray(sections)
      ? sections.map((section) => String(section?.id || "").trim()).filter(Boolean)
      : []
  );
  const invalid = (Array.isArray(outboundLinks) ? outboundLinks : []).filter((link) => {
    const value = String(link?.source_context || "");
    if (!value.startsWith("section:")) {
      return false;
    }
    const id = value.split(":")[1] || "";
    return !sectionIds.has(id);
  });
  if (invalid.length > 0) {
    return {
      status: "fail" as const,
      message: "Outbound section link source_context does not match section id.",
      evidence: { invalid_count: invalid.length },
    };
  }
  return { status: "pass" as const };
}

function checkContactLinkCanonicalized(
  outboundLinks: any[],
  baseDomain?: string,
  language?: string,
  urlLanguageStrategy?: string
) {
  if (!outboundLinks) {
    return missingData("internal_links");
  }
  const normalizedLang = String(language || "").toLowerCase();
  const strategy = String(urlLanguageStrategy || "").toLowerCase();
  const usesSubfolders = strategy.includes("subfolders");
  const expected =
    normalizedLang === "de"
      ? usesSubfolders
        ? "/de/kontakt"
        : "/kontakt"
      : "/contact";
  const matches = (Array.isArray(outboundLinks) ? outboundLinks : []).filter(
    (link) => String(link?.type || "") === "contact"
  );
  if (matches.length === 0) {
    return notApplicable("contact_link");
  }
  const bad = matches.filter((link) => {
    const url = String(link?.url || "").toLowerCase();
    if (url.startsWith("http") && baseDomain) {
      const base = baseDomain.replace(/^https?:\/\//, "").replace(/^www\./, "");
      if (!url.includes(base)) {
        return true;
      }
      try {
        const parsed = new URL(url);
        return parsed.pathname !== expected;
      } catch {
        return true;
      }
    }
    return url !== expected;
  });
  if (bad.length > 0) {
    return {
      status: "warn" as const,
      message: "Contact link not canonicalized.",
      evidence: { expected },
    };
  }
  return { status: "pass" as const };
}

function checkPagepackageMinContainsInternalLinks(pagePackage: Record<string, any>) {
  const links = pagePackage?.internal_links?.outbound;
  if (!Array.isArray(links)) {
    return {
      status: "warn" as const,
      message: "pagepackage.min missing internal_links.outbound",
      reason: "pagepackage_min_missing_links",
    };
  }
  return { status: "pass" as const };
}

function checkPagepackageMinContainsFaq(pagePackage: Record<string, any>) {
  const faq = pagePackage?.content?.faq;
  if (!Array.isArray(faq)) {
    return {
      status: "warn" as const,
      message: "pagepackage.min missing faq",
      reason: "pagepackage_min_missing_faq",
    };
  }
  return { status: "pass" as const };
}

function checkDuplicateRisk(
  targetUrl: string | undefined,
  report: Record<string, string>[],
  minSimilarity: number
) {
  if (!targetUrl || report.length === 0) {
    return notApplicable("duplicate_report");
  }
  const match = report.find((row) => {
    const similarity = Number(row.similarity_score || 0);
    return (
      similarity >= minSimilarity &&
      (row.url_a === targetUrl || row.url_b === targetUrl)
    );
  });
  if (match) {
    return {
      status: "warn",
      message: "Duplicate content risk detected.",
      evidence: match,
    };
  }
  return { status: "pass" };
}

function checkCannibalization(
  targetUrl: string | undefined,
  keyword: string | undefined,
  report: Record<string, string>[]
) {
  if (!targetUrl || !keyword || report.length === 0) {
    return notApplicable("cannibalization_report");
  }
  const key = keyword.toLowerCase();
  const match = report.find((row) => {
    const rowKeyword = (row.keyword || "").toLowerCase();
    const urls = (row.conflicting_urls || "").split(",").map((url) => url.trim());
    return rowKeyword === key && urls.includes(targetUrl);
  });
  if (match) {
    return {
      status: "warn",
      message: "Cannibalization risk detected.",
      evidence: match,
    };
  }
  return { status: "pass" };
}

function checkBannedPhrases(body: string | undefined, h1: string | undefined, phrases: string[]) {
  if (!body && !h1) {
    return missingData("content");
  }
  const text = `${h1 || ""} ${body || ""}`.toLowerCase();
  const found = phrases.filter((phrase) => text.includes(phrase.toLowerCase()));
  if (found.length > 0) {
    return {
      status: "warn",
      message: "Banned phrases detected.",
      evidence: { found },
    };
  }
  return { status: "pass" };
}

function checkRequireSnapshot(snapshotStatus?: { isFresh: boolean; reason: string }) {
  if (!snapshotStatus) {
    return missingData("snapshot_status");
  }
  if (!snapshotStatus.isFresh) {
    return {
      status: "fail" as const,
      message: `Site snapshot required: ${snapshotStatus.reason}`,
      evidence: { reason: snapshotStatus.reason },
    };
  }
  return { status: "pass" as const };
}

function missingData(label: string) {
  return {
    status: "missing_data" as const,
    reason: "missing_data",
    evidence: { field: label },
  };
}

function notApplicable(label: string) {
  return {
    status: "not_applicable" as const,
    reason: "not_applicable",
    evidence: { field: label },
  };
}

function applySeverityOverrides(
  ruleId: string,
  severity: string,
  overrides: Record<string, unknown>
): string {
  const warnToFail = (overrides.warn_to_fail_rules as string[]) || [];
  const failToWarn = (overrides.fail_to_warn_rules as string[]) || [];
  if (severity === "warn" && warnToFail.includes(ruleId)) {
    return "fail";
  }
  if (severity === "fail" && failToWarn.includes(ruleId)) {
    return "warn";
  }
  return severity;
}

function buildModeSeverityOverrides(mode?: string, siteState?: string): Record<string, unknown> {
  if (mode !== "strict_production") {
    return {};
  }
  const warnToFailRules = ["TITLE_PRIMARY_KEYWORD", "H1_PRIMARY_KEYWORD", "KEYWORD_STUFFING"];
  if ((siteState || "").toLowerCase() === "new") {
    warnToFailRules.push("SLUG_PRIMARY_KEYWORD");
  }
  return { warn_to_fail_rules: warnToFailRules };
}

function mergeSeverityOverrides(
  base: Record<string, unknown>,
  extra: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base } as Record<string, unknown>;
  const baseWarn = (base.warn_to_fail_rules as string[]) || [];
  const baseFail = (base.fail_to_warn_rules as string[]) || [];
  const extraWarn = (extra.warn_to_fail_rules as string[]) || [];
  const extraFail = (extra.fail_to_warn_rules as string[]) || [];
  merged.warn_to_fail_rules = Array.from(new Set([...baseWarn, ...extraWarn]));
  merged.fail_to_warn_rules = Array.from(new Set([...baseFail, ...extraFail]));
  return merged;
}

function resolveEffectiveStatus(result: RuleResult): RuleResult["status"] {
  if (result.status === "block") {
    return "block";
  }
  if (result.status === "fail" && result.severity === "warn") {
    return "warn";
  }
  if (result.status === "warn" && result.severity === "fail") {
    return "fail";
  }
  return result.status;
}

function buildQaSummary(
  current: Record<string, any> | undefined,
  results: RuleResult[],
  allowMissingData: boolean
) {
  const base = current || {
    status: "PASS",
    fail_rules: [],
    warn_rules: [],
    fix_list: [],
    completeness_score: 100,
    assumptions: [],
  };

  const failRules: string[] = [];
  const warnRules: string[] = [];
  const fixList: Array<Record<string, unknown>> = [];

  const missingCount = results.filter((result) =>
    (result.reason || "").toString().startsWith("missing_data")
  ).length;

  results.forEach((result) => {
    const effectiveStatus = resolveEffectiveStatus(result);
    if (effectiveStatus === "not_applicable") {
      return;
    }

    if (effectiveStatus === "missing_data") {
      return;
    }

    if (effectiveStatus === "fail" || effectiveStatus === "block") {
      failRules.push(result.rule_id);
    } else if (effectiveStatus === "warn") {
      warnRules.push(result.rule_id);
    }

    if (effectiveStatus !== "pass") {
      fixList.push({
        rule_id: result.rule_id,
        message: result.message,
        fix_instructions: result.fix_instructions,
        evidence: result.evidence,
      });
    }
  });

  const checksRun = results.filter((result) => resolveEffectiveStatus(result) !== "not_applicable").length;
  const checksPassed = results.filter((result) => resolveEffectiveStatus(result) === "pass").length;
  const ruleScore = checksRun > 0 ? Math.round((checksPassed / checksRun) * 100) : 0;
  const status = failRules.length > 0 ? "BLOCK" : warnRules.length > 0 ? "WARN" : "PASS";
  const completenessScore = checksRun > 0 ? Math.round(((checksRun - missingCount) / checksRun) * 100) : 0;

  const topIssues = results
    .map((result) => ({
      result,
      status: resolveEffectiveStatus(result),
    }))
    .filter((entry) => entry.status !== "pass" && entry.status !== "not_applicable")
    .sort((a, b) => {
      const weight = (status: RuleResult["status"]) => (status === "block" || status === "fail" ? 2 : 1);
      return weight(b.status) - weight(a.status);
    })
    .slice(0, 10)
    .map((entry) => ({
      rule_id: entry.result.rule_id,
      severity: entry.status,
      status: entry.status,
      message: entry.result.message,
      fix_hint: entry.result.fix_instructions,
      evidence: entry.result.evidence,
    }));

  return {
    ...base,
    status,
    fail_rules: Array.from(new Set(failRules)),
    warn_rules: Array.from(new Set(warnRules)),
    fix_list: [...fixList],
    checks_run: checksRun,
    rule_score: ruleScore,
    completeness_score: completenessScore,
    top_issues: topIssues,
    missing_data_policy: allowMissingData ? "allow" : "block",
  };
}

function buildQaBlock(current: Record<string, any> | undefined, ruleId: string, details: unknown) {
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

function applyMissingDataPolicy(results: RuleResult[], allowMissingData: boolean): RuleResult[] {
  if (allowMissingData) {
    return results;
  }
  return results.map((result) => {
    if (result.status !== "missing_data") {
      return result;
    }
    const severity = (result.severity || "warn").toLowerCase();
    return {
      ...result,
      status: severity === "fail" ? "fail" : "warn",
      message: "Missing data without preflight allowance.",
      reason: "missing_data_blocked",
    };
  });
}

async function loadPreflightReport(
  runDir: string,
  tenantPath: string
): Promise<{ allow_missing_data?: boolean } | null> {
  const tenantName = tenantPath.split("/").pop() || "tenant";
  const reportPath = `${runDir}/${tenantName}/preflight_report.json`;
  if (!(await fileExists(reportPath))) {
    return null;
  }
  try {
    return await readJsonFile<{ allow_missing_data?: boolean }>(reportPath);
  } catch {
    return null;
  }
}

function parseParams(raw?: string): Record<string, any> {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return {};
  }
}

function buildChecksLog(pageId: string, rules: RuleDefinition[], results: RuleResult[]) {
  return {
    page_id: pageId,
    checked_at: new Date().toISOString(),
    checks: rules.map((rule) => {
      const result = results.find((entry) => entry.rule_id === rule.rule_id);
      const effectiveStatus = result ? resolveEffectiveStatus(result) : "not_applicable";
      const message =
        effectiveStatus === "pass" || effectiveStatus === "not_applicable"
          ? undefined
          : result?.message || rule.message;
      return {
        rule_id: rule.rule_id,
        severity: result?.severity || rule.severity,
        status: effectiveStatus,
        message,
        evidence: result?.evidence,
        reason: result?.reason,
      };
    }),
  };
}

async function writeChecksLog(
  runDir: string,
  tenantPath: string,
  pageId: string,
  language: string | undefined,
  payload: Record<string, unknown>
) {
  const tenantName = tenantPath.split("/").pop() || "tenant";
  const lang = language || "unknown";
  const targetPath = `${runDir}/${tenantName}/pages/${pageId}/${lang}/qa_checks_log.json`;
  await ensureDir(targetPath);
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

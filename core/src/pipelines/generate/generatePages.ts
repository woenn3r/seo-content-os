import { readCsvKeyValue, readCsvRows } from "../../utils/csv";
import { ensureDir, fileExists, listFiles, readJsonFile, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { normalizeUrl } from "../../utils/url";
import { loadParsingRules, parseCsvFields } from "../../utils/parseCsvFields";
import { promises as fs } from "fs";
import { OpenAIClient } from "../../clients/openai";
import { RunProfile } from "../../config/loadRunProfile";
import { TenantConfig } from "../../config/loadTenantConfig";
import { buildUsageSummary, estimateCostUsd, UsageRecord } from "../../utils/usage";
import { retrieveTenantSummary } from "../../rag/tenantRag";
import { runWebResearch } from "../../research/webResearch";

const PAGESPEC_PATH = "data/03_strategy/pagespec/v1/11_pagespec.csv";
const OUTPUT_DIR = "data/04_generation/page_packages/v1";
const PAGEPACKAGE_SCHEMA_PATH =
  "seo_content_os_scaffold_v4/shared/contracts/v1/pagepackage.schema.json";

type Input = {
  tenantPath: string;
  runId: string;
  runDir: string;
  runProfile: RunProfile;
  tenantConfig: TenantConfig;
  iteration?: number;
  fixListByPage?: Record<string, unknown[]>;
};

export async function generatePages(input: Input): Promise<void> {
  logger.info("generate.start", { tenantPath: input.tenantPath, iteration: input.iteration || 1 });
  const specPath = `${input.tenantPath}/${PAGESPEC_PATH}`;
  const rows = await readCsvRows(specPath);
  const parsingRules = await loadParsingRules(process.cwd());
  const usageRecords: UsageRecord[] = [];

  if (rows.length === 0) {
    logger.warn("generate.empty", { specPath });
    return;
  }

  const pageIds = rows.map((row) => row.page_id).filter(Boolean) as string[];
  const outputDir = `${input.tenantPath}/${OUTPUT_DIR}`;
  try {
    const existing = await listFiles(outputDir);
    const allowed = new Set(pageIds.map((id) => `${id}.json`));
    await Promise.all(
      existing
        .filter((file) => file.endsWith(".json") && !allowed.has(file))
        .map((file) => fs.unlink(`${outputDir}/${file}`))
    );
  } catch {
    // Missing output dir is fine; it will be created as needed.
  }

  for (const row of rows) {
    if (!row.page_id) {
      continue;
    }

    const parsed = parseCsvFields(row, parsingRules);
    const pagePackage = await buildPagePackage({
      tenantPath: input.tenantPath,
      pageSpec: parsed,
      runProfile: input.runProfile,
      tenantConfig: input.tenantConfig,
      iteration: input.iteration || 1,
      fixList: input.fixListByPage?.[row.page_id] as unknown[] | undefined,
      usageRecords,
      runDir: input.runDir,
    });
    const targetPath = `${outputDir}/${row.page_id}.json`;
    await ensureDir(targetPath);
    await writeFile(targetPath, `${JSON.stringify(pagePackage, null, 2)}\n`);
  }

  await persistUsage(input.runDir, input.runId, usageRecords);
  logger.info("generate.done", { tenantPath: input.tenantPath });
}

async function buildPagePackage(input: {
  tenantPath: string;
  pageSpec: Record<string, unknown>;
  runProfile: RunProfile;
  tenantConfig: TenantConfig;
  iteration: number;
  fixList?: unknown[];
  usageRecords: UsageRecord[];
  runDir: string;
}): Promise<Record<string, unknown>> {
  const pageId = String(input.pageSpec.page_id || "");
  const language = String(input.pageSpec.language || "unknown");
  const primaryKeyword = String(input.pageSpec.primary_keyword || pageId || "Stub");
  const slug = extractSlug(String(input.pageSpec.target_url || `/${pageId}`));

  const projectConfig = await readCsvKeyValue(
    `${input.tenantPath}/data/01_project/project_config/v1/01_project_config.csv`
  );

  const retrievalModel = input.runProfile.retrieval_model || input.runProfile.generator_model || "gpt-4.1-mini";
  const retrieval = await retrieveTenantSummary(
    input.tenantPath,
    `PageSpec: ${primaryKeyword} (${pageId}). Focus on offers, brand voice, and site context.`,
    retrievalModel
  );
  recordUsage(input.usageRecords, {
    scope: "retrieval",
    page_id: pageId,
    model: retrievalModel,
    ...retrieval.usage,
  });

  let researchResult: Record<string, unknown> | null = null;
  if (input.tenantConfig.allowExternalSources && process.env.OPENAI_API_KEY) {
    const researchModel = input.runProfile.research_model || input.runProfile.generator_model || "gpt-4.1-mini";
    const research = await runWebResearch(`${primaryKeyword} best practices`, researchModel);
    researchResult = research.result;
    recordUsage(input.usageRecords, {
      scope: "research",
      page_id: pageId,
      model: researchModel,
      ...research.usage,
    });
    await writeRunArtifact(input.runDir, input.tenantPath, pageId, language, "external_sources.json", researchResult);
  }

  await writeRunArtifact(input.runDir, input.tenantPath, pageId, language, "retrieval_summary.json", retrieval.result);

  if (!process.env.OPENAI_API_KEY) {
    return buildStubPackage(primaryKeyword, slug, input.pageSpec);
  }

  const schema = await readJsonFile<Record<string, unknown>>(`${process.cwd()}/${PAGEPACKAGE_SCHEMA_PATH}`);
  const client = OpenAIClient.fromEnv();
  const model = input.runProfile.generator_model || "gpt-4.1-mini";

  const prompt = buildGenerationPrompt({
    pageSpec: input.pageSpec,
    projectConfig,
    retrievalSummary: retrieval.result,
    externalSources: researchResult,
    fixList: input.iteration > 1 ? input.fixList : undefined,
  });

  const response = await client.responsesJson<Record<string, unknown>>({
    model,
    instructions:
      "Generate a PagePackage JSON that matches the schema exactly. Use retrieval summary and sources when relevant.",
    prompt,
    jsonSchema: { name: "pagepackage", schema, strict: true },
  });

  recordUsage(input.usageRecords, {
    scope: "generation",
    page_id: pageId,
    model,
    ...response.usage,
  });

  return normalizeStructuredFields(
    response.data as Record<string, any>,
    projectConfig?.base_domain,
    String(input.pageSpec.language || ""),
    String(projectConfig?.url_language_strategy || "")
  );
}

function extractSlug(targetUrl: string): string {
  const normalized = normalizeUrl(targetUrl);
  if (!normalized) {
    return "/";
  }

  try {
    const url = new URL(normalized);
    return url.pathname || "/";
  } catch {
    if (normalized.startsWith("/")) {
      return normalized;
    }
    return `/${normalized}`;
  }
}

function buildStubPackage(primaryKeyword: string, slug: string, pageSpec: Record<string, unknown>) {
  return {
    meta: {
      title: `${primaryKeyword} | ${pageSpec.offer_id || "Service"}`,
      description: `Stub description for ${primaryKeyword}.`,
      canonical: pageSpec.target_url || undefined,
      robots: "index,follow",
    },
    url: {
      slug,
      breadcrumbs: [primaryKeyword],
    },
    content: {
      h1: primaryKeyword,
      sections: [],
      body: `Stub content for ${primaryKeyword}.`,
    },
    internal_links: {
      outbound: [],
      inbound_suggestions: [],
    },
    schema: {
      jsonld: "{}",
      notes: "stub",
    },
    qa: {
      status: "PASS",
      fail_rules: [],
      warn_rules: [],
      fix_list: [],
      completeness_score: 100,
      assumptions: ["Stub generator"],
    },
  };
}

function normalizeStructuredFields(
  payload: Record<string, any>,
  baseDomain?: string,
  language?: string,
  urlLanguageStrategy?: string
): Record<string, any> {
  const content = payload.content || {};
  const body = String(content.body || "");
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const normalizedSections = normalizeSections(sections, body, String(content.h1 || ""));
  const normalizedFaq = normalizeFaq(content.faq, body);
  const normalizedCtas = normalizeCtas(content.ctas, body);
  const normalizedImages = normalizeImages(content.images, body);
  const normalizedTables = normalizeTables(content.tables, body);
  const normalizedInternalLinks = normalizeInternalLinks(
    payload.internal_links,
    baseDomain,
    body,
    normalizedSections,
    normalizedCtas,
    normalizedFaq,
    language,
    urlLanguageStrategy
  );

  return {
    ...payload,
    content: {
      ...content,
      sections: normalizedSections,
      faq: normalizedFaq,
      ctas: normalizedCtas,
      images: normalizedImages,
      tables: normalizedTables,
    },
    internal_links: normalizedInternalLinks,
  };
}

function normalizeSections(sections: any[], body: string, h1: string) {
  const extracted = extractSectionsFromBody(body);
  if (extracted.length > 0) {
    return extracted;
  }
  if (sections.length > 0) {
    return sections.map((section, index) => ({
      id: section?.id || `section_${index + 1}`,
      heading: section?.heading || `Section ${index + 1}`,
      intent: section?.intent || "inform",
      key_points: Array.isArray(section?.key_points) ? section.key_points : [],
      internal_links: Array.isArray(section?.internal_links) ? section.internal_links : [],
      ctas: Array.isArray(section?.ctas) ? section.ctas : [],
    }));
  }
  if (body.trim()) {
    return [
      {
        id: "section_1",
        heading: h1 || "Section 1",
        intent: "inform",
        key_points: [],
        internal_links: [],
        ctas: [],
      },
    ];
  }
  return [];
}

function normalizeFaq(faq: any, body: string) {
  const extracted = extractFaqFromBody(body);
  if (extracted.length > 0) {
    return extracted;
  }
  if (!Array.isArray(faq)) {
    return [];
  }
  return faq
    .map((item) => ({
      question: item?.question || "",
      answer: item?.answer || "",
      schema_include: item?.schema_include !== false,
    }))
    .filter((item) => item.question || item.answer);
}

function normalizeCtas(ctas: any, body: string) {
  const extracted = extractCtasFromBody(body);
  if (extracted.length > 0) {
    return extracted;
  }
  if (!Array.isArray(ctas)) {
    return [];
  }
  return ctas
    .map((item) => ({
      label: item?.label || "",
      url: item?.url || "",
      variant: item?.variant || "primary",
      position: item?.position || "body",
    }))
    .filter((item) => item.label || item.url);
}

function normalizeImages(images: any, body: string) {
  const extracted = extractImagesFromBody(body);
  if (extracted.length > 0) {
    return extracted;
  }
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .map((item) => ({
      src: item?.src || "",
      alt: item?.alt || "",
      title: item?.title || undefined,
      width: item?.width || undefined,
      height: item?.height || undefined,
      caption: item?.caption || undefined,
    }))
    .filter((item) => item.src || item.alt);
}

function normalizeTables(tables: any, body: string) {
  if (!Array.isArray(tables)) {
    return [];
  }
  return tables
    .map((item) => ({
      title: item?.title || "",
      columns: Array.isArray(item?.columns) ? item.columns : [],
      rows: Array.isArray(item?.rows) ? item.rows : [],
      notes: item?.notes || undefined,
    }))
    .filter((item) => item.columns.length > 0 || item.rows.length > 0);
}

function normalizeInternalLinks(
  internalLinks: any,
  baseDomain: string | undefined,
  body: string,
  sections: Array<{ id: string; heading: string }>,
  ctas: Array<{ label: string; url: string; variant: string; position: string }>,
  faq: Array<{ question: string; answer: string; schema_include: boolean }>,
  language?: string,
  urlLanguageStrategy?: string
) {
  const outbound = Array.isArray(internalLinks?.outbound) ? internalLinks.outbound : [];
  const inbound = Array.isArray(internalLinks?.inbound_suggestions) ? internalLinks.inbound_suggestions : [];
  const normalizedOutbound = normalizeOutboundLinks(
    outbound,
    baseDomain,
    body,
    sections,
    ctas,
    faq,
    language,
    urlLanguageStrategy
  );
  const normalizedInbound = normalizeInboundSuggestions(inbound);
  return {
    outbound: normalizedOutbound,
    inbound_suggestions: normalizedInbound,
  };
}

function normalizeOutboundLinks(
  outbound: any[],
  baseDomain: string | undefined,
  body: string,
  sections: Array<{ id: string; heading: string }>,
  ctas: Array<{ label: string; url: string; variant: string; position: string }>,
  faq: any[],
  language?: string,
  urlLanguageStrategy?: string
) {
  const allowedTypes = new Set([
    "service",
    "blog",
    "contact",
    "about",
    "case_study",
    "pricing",
    "faq",
    "other",
  ]);
  const fromCtas = ctas
    .filter((cta) => cta.label || cta.url)
    .map((cta) => ({
      source_context: `cta:${normalizeCtaPosition(cta.position || "body")}`,
      label: cta.label || "Mehr erfahren",
      url: normalizeUrlPath(cta.url || "", baseDomain),
      type: classifyLinkType(cta.url || ""),
      reason: "Primary CTA link",
    }));
  const fromBody = extractLinksFromBody(body).map((link) => ({
    source_context: "body",
    label: link.label,
    url: normalizeUrlPath(link.url, baseDomain),
    type: classifyLinkType(link.url),
    reason: "Contextual link in body",
  }));
  const fromFaq = (Array.isArray(faq) ? faq : [])
    .flatMap((item: any, index: number) =>
      Array.isArray(item?.internal_links) ? item.internal_links.map((link: any) => ({ link, index })) : []
    )
    .map(({ link, index }) => ({
      source_context: `faq:${index}`,
      label: link?.label || "",
      url: normalizeUrlPath(link?.url || "", baseDomain),
      type: classifyLinkType(link?.url || ""),
      reason: "FAQ internal link",
    }));
  const fromSections = (Array.isArray(sections) ? sections : [])
    .flatMap((section: any) =>
      Array.isArray(section?.internal_links) ? section.internal_links.map((link: any) => ({ link, section })) : []
    )
    .map(({ link, section }) => ({
      source_context: `section:${normalizeSectionId(section?.id || "section")}`,
      label: link?.label || "",
      url: normalizeUrlPath(link?.url || "", baseDomain),
      type: classifyLinkType(link?.url || ""),
      reason: "Section internal link",
    }));

  const merged = [...outbound, ...fromCtas, ...fromBody, ...fromFaq, ...fromSections]
    .map((item) => ({
      source_context: normalizeSourceContext(item?.source_context),
      label: item?.label || item?.anchor || "",
      url: normalizeUrlPath(item?.url || item?.href || "", baseDomain),
      type: item?.type || classifyLinkType(item?.url || item?.href || ""),
      reason: item?.reason || "Internal link recommendation",
    }))
    .map((item) => ({
      ...item,
      type: allowedTypes.has(item.type) ? item.type : classifyLinkType(item.url),
    }))
    .map((item) => ({
      ...item,
      url: canonicalizeContactUrl(item.url, item.type, language, urlLanguageStrategy),
    }))
    .filter((item) => item.label || item.url);

  return dedupeLinks(merged);
}

function normalizeInboundSuggestions(inbound: any[]) {
  return inbound
    .map((item) => ({
      from_page_id: item?.from_page_id || undefined,
      from_url: item?.from_url || undefined,
      suggested_anchor: item?.suggested_anchor || "",
      target_url: item?.target_url || "",
      reason: item?.reason || "Suggested inbound link",
    }))
    .filter((item) => item.suggested_anchor || item.target_url);
}

function normalizeSourceContext(raw: string | undefined) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return "body";
  }
  if (value.startsWith("section:")) {
    const id = value.split(":")[1] || "section";
    return `section:${normalizeSectionId(id)}`;
  }
  if (value.startsWith("cta:")) {
    const position = value.split(":")[1] || "bottom";
    return `cta:${normalizeCtaPosition(position)}`;
  }
  if (value.startsWith("faq:")) {
    const idx = value.split(":")[1];
    const index = Number(idx);
    if (!Number.isNaN(index) && index >= 0) {
      return `faq:${index}`;
    }
    return "faq:0";
  }
  if (value === "body") {
    return "body";
  }
  return "body";
}

function normalizeSectionId(raw: string) {
  return String(raw || "section")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeCtaPosition(raw: string) {
  const value = String(raw || "").trim().toLowerCase();
  if (["top", "inline", "bottom", "footer"].includes(value)) {
    return value;
  }
  if (["header", "hero"].includes(value)) {
    return "top";
  }
  if (["body", "section_end", "block"].includes(value)) {
    return "inline";
  }
  if (["page_end", "end"].includes(value)) {
    return "bottom";
  }
  return "bottom";
}

function extractLinksFromBody(body: string) {
  const items: Array<{ label: string; url: string }> = [];
  const linkRegex = /<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)<\/a>/gi;
  let match = linkRegex.exec(body);
  while (match) {
    const url = match[1].trim();
    const label = match[2].replace(/<[^>]+>/g, "").trim();
    if (url || label) {
      items.push({ label: label || "Mehr erfahren", url });
    }
    match = linkRegex.exec(body);
  }
  return items;
}

function normalizeUrlPath(url: string, baseDomain?: string) {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.startsWith("http") && baseDomain) {
    const base = baseDomain.replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (trimmed.includes(base)) {
      try {
        const parsed = new URL(trimmed);
        return parsed.pathname || "/";
      } catch {
        return trimmed;
      }
    }
  }
  return trimmed;
}

function canonicalizeContactUrl(url: string, type: string, language?: string, urlLanguageStrategy?: string) {
  if (type !== "contact") {
    return url;
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
  if (!url) {
    return expected;
  }
  if (url.startsWith("http")) {
    try {
      const parsed = new URL(url);
      return expected;
    } catch {
      return expected;
    }
  }
  if (url.startsWith("/")) {
    return expected;
  }
  return expected;
}

function classifyLinkType(url: string) {
  const normalized = String(url || "").toLowerCase();
  if (normalized.includes("/kontakt") || normalized.includes("/contact")) {
    return "contact";
  }
  if (normalized.includes("/blog")) {
    return "blog";
  }
  if (normalized.includes("/case") || normalized.includes("case-study")) {
    return "case_study";
  }
  if (normalized.includes("/preise") || normalized.includes("/pricing")) {
    return "pricing";
  }
  if (normalized.includes("/ueber") || normalized.includes("/about")) {
    return "about";
  }
  if (normalized.includes("/faq")) {
    return "faq";
  }
  if (normalized.includes("/service") || normalized.includes("/leistungen")) {
    return "service";
  }
  return "other";
}

function dedupeLinks(links: Array<{ label: string; url: string }>) {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.label}|${link.url}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractSectionsFromBody(body: string) {
  const sections: Array<{
    id: string;
    heading: string;
    intent: string;
    key_points: string[];
    internal_links: Array<{ label: string; url: string }>;
    ctas: Array<{ label: string; url: string; variant: string; position: string }>;
  }> = [];
  const sectionRegex = /<section>([\s\S]*?)<\/section>/gi;
  let match = sectionRegex.exec(body);
  let index = 1;
  while (match) {
    const block = match[1];
    const headingMatch = /<h2>(.*?)<\/h2>/i.exec(block);
    const heading = headingMatch ? headingMatch[1].trim() : `Section ${index}`;
    sections.push({
      id: `section_${index}`,
      heading,
      intent: "inform",
      key_points: [],
      internal_links: [],
      ctas: [],
    });
    index += 1;
    match = sectionRegex.exec(body);
  }
  return sections;
}

function extractFaqFromBody(body: string) {
  const items: Array<{ question: string; answer: string; schema_include: boolean }> = [];
  const qaRegex = /<dt>(.*?)<\/dt>\s*<dd>(.*?)<\/dd>/gi;
  let match = qaRegex.exec(body);
  while (match) {
    const question = match[1].trim();
    const answer = match[2].trim();
    if (question || answer) {
      items.push({ question, answer, schema_include: true });
    }
    match = qaRegex.exec(body);
  }
  return items;
}

function extractCtasFromBody(body: string) {
  const items: Array<{ label: string; url: string; variant: string; position: string }> = [];
  const linkRegex = /<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)<\/a>/gi;
  let match = linkRegex.exec(body);
  while (match) {
    const url = match[1].trim();
    const label = match[2].replace(/<[^>]+>/g, "").trim();
    if (url || label) {
      items.push({ label: label || "Mehr erfahren", url, variant: "primary", position: "body" });
    }
    match = linkRegex.exec(body);
  }
  return items;
}

function extractImagesFromBody(body: string) {
  const items: Array<{ src: string; alt: string; title?: string; width?: number; height?: number; caption?: string }> = [];
  const imgRegex = /<img[^>]*src=\"([^\"]+)\"[^>]*alt=\"([^\"]*)\"[^>]*>/gi;
  let match = imgRegex.exec(body);
  while (match) {
    const src = match[1].trim();
    const alt = match[2].trim();
    if (src || alt) {
      items.push({ src, alt });
    }
    match = imgRegex.exec(body);
  }
  return items;
}

function buildGenerationPrompt(input: {
  pageSpec: Record<string, unknown>;
  projectConfig: Record<string, string>;
  retrievalSummary: { summary: string; citations: Array<{ source: string; snippet: string }> };
  externalSources: Record<string, unknown> | null;
  fixList?: unknown[];
}): string {
  return [
    "Generate a single PagePackage JSON.",
    `PageSpec: ${JSON.stringify(input.pageSpec)}`,
    `ProjectConfig: ${JSON.stringify(input.projectConfig)}`,
    `RetrievalSummary: ${JSON.stringify(input.retrievalSummary)}`,
    input.externalSources ? `ExternalSources: ${JSON.stringify(input.externalSources)}` : "",
    input.fixList ? `FixList: ${JSON.stringify(input.fixList)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function persistUsage(runDir: string, runId: string, records: UsageRecord[]): Promise<void> {
  const usagePath = `${runDir}/usage.json`;
  let existing: UsageRecord[] = [];
  if (await fileExists(usagePath)) {
    try {
      const previous = await readJsonFile<{ records?: UsageRecord[] }>(usagePath);
      existing = previous.records || [];
    } catch {
      existing = [];
    }
  }
  const summary = buildUsageSummary(runId, [...existing, ...records]);
  await ensureDir(usagePath);
  await writeFile(usagePath, `${JSON.stringify(summary, null, 2)}\n`);
}

function recordUsage(
  records: UsageRecord[],
  input: { scope: UsageRecord["scope"]; page_id?: string; model: string; input_tokens: number; output_tokens: number; total_tokens: number }
): void {
  records.push({
    scope: input.scope,
    page_id: input.page_id,
    model: input.model,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    total_tokens: input.total_tokens,
    cost_usd: estimateCostUsd(input.model, input.input_tokens, input.output_tokens),
    created_at: new Date().toISOString(),
  });
}

async function writeRunArtifact(
  runDir: string,
  tenantPath: string,
  pageId: string,
  language: string,
  filename: string,
  payload: Record<string, unknown>
): Promise<void> {
  const tenantName = tenantPath.split("/").pop() || "tenant";
  const targetPath = `${runDir}/${tenantName}/pages/${pageId}/${language}/${filename}`;
  await ensureDir(targetPath);
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

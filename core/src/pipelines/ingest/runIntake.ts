import { readCsvHeaders, readCsvRows, upsertCsvKeyValue, writeCsvRows } from "../../utils/csv";
import { ensureDir, readJsonFile, writeFile } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { loadRunProfile } from "../../config/loadRunProfile";

type IntakeQuestion = {
  question_id: string;
  level: string;
  required: string;
  condition_json?: string;
  answer_type?: string;
  allowed_values?: string;
  default_value?: string;
  target_files?: string;
  target_fields?: string;
  transform_hint?: string;
};

type IntakeResult = {
  answered: string[];
  skipped: Array<{ question_id: string; reason: string }>;
  missing_required: string[];
  errors: Array<{ question_id: string; error: string }>;
  written: Array<{ question_id: string; target_file: string; target_field: string }>;
  placeholders: Array<{ question_id: string; value: string }>;
};

type IntakeInput = {
  tenantPath: string;
  profileId: string;
  answersPath?: string;
  pageId?: string;
};

export async function runIntake(input: IntakeInput): Promise<void> {
  const repoRoot = process.cwd();
  const runProfile = await loadRunProfile(input.tenantPath, input.profileId);
  const questions = await loadQuestions(repoRoot);
  const answers = await buildAnswerMap(questions, input.answersPath);
  const report: IntakeResult = {
    answered: [],
    skipped: [],
    missing_required: [],
    errors: [],
    written: [],
    placeholders: [],
  };

  for (const question of questions) {
    const questionId = question.question_id;
    if (!questionId) {
      continue;
    }

    if (question.level === "page" && !input.pageId) {
      report.skipped.push({ question_id: questionId, reason: "missing_page_context" });
      continue;
    }

    if (question.condition_json && !evaluateCondition(question.condition_json, answers)) {
      report.skipped.push({ question_id: questionId, reason: "condition_false" });
      continue;
    }

    const rawAnswer = answers[questionId] ?? question.default_value ?? "";
    const answer = String(rawAnswer).trim();
    if (!answer) {
      if (question.required === "yes") {
        report.missing_required.push(questionId);
      }
      continue;
    }

    try {
      await writeAnswer({
        tenantPath: input.tenantPath,
        runProfileLanguage: runProfile.languages?.[0] || "de",
        pageId: input.pageId,
        question,
        answer,
        report,
      });
      report.answered.push(questionId);
    } catch (error) {
      report.errors.push({ question_id: questionId, error: String(error) });
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `${input.tenantPath}/data/01_project/intake_runs/${runId}/intake_run_report.json`;
  await ensureDir(reportPath);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  logger.info("intake.done", { tenantPath: input.tenantPath, reportPath });

  if (report.errors.length > 0 || report.missing_required.length > 0) {
    throw new Error("Intake blocked: errors or missing required answers.");
  }
}

async function loadQuestions(repoRoot: string): Promise<IntakeQuestion[]> {
  const path = `${repoRoot}/seo_content_os_scaffold_v4/shared/intake/v1/intake_questions.csv`;
  return readCsvRows(path) as IntakeQuestion[];
}

async function buildAnswerMap(
  questions: IntakeQuestion[],
  path?: string
): Promise<Record<string, string>> {
  const defaults: Record<string, string> = {};
  questions.forEach((question) => {
    if (question.question_id && question.default_value) {
      defaults[question.question_id] = question.default_value;
    }
  });

  if (!path) {
    return defaults;
  }

  const provided = await readJsonFile<Record<string, string>>(path);
  return { ...defaults, ...provided };
}

function evaluateCondition(conditionJson: string, answers: Record<string, string>): boolean {
  try {
    const condition = JSON.parse(conditionJson) as any;
    return evaluateConditionNode(condition, answers);
  } catch {
    return false;
  }
}

function evaluateConditionNode(node: any, answers: Record<string, string>): boolean {
  if (!node) {
    return true;
  }

  if (node.any && Array.isArray(node.any)) {
    return node.any.some((child: any) => evaluateConditionNode(child, answers));
  }

  if (node.all && Array.isArray(node.all)) {
    return node.all.every((child: any) => evaluateConditionNode(child, answers));
  }

  const qid = node.qid;
  const op = node.op;
  const value = node.value;
  const answer = answers[qid] || "";
  switch (op) {
    case "eq":
      return answer === value;
    case "not_eq":
      return answer !== value;
    case "contains":
      return answer.split("|").includes(value) || answer.split(",").includes(value);
    case "not_contains":
      return !answer.split("|").includes(value) && !answer.split(",").includes(value);
    default:
      return false;
  }
}

async function writeAnswer(input: {
  tenantPath: string;
  runProfileLanguage: string;
  pageId?: string;
  question: IntakeQuestion;
  answer: string;
  report: IntakeResult;
}): Promise<void> {
  const targetFiles = (input.question.target_files || "").split(";").map((t) => t.trim()).filter(Boolean);
  const targetFields = (input.question.target_fields || "").split(";").map((t) => t.trim()).filter(Boolean);

  if (targetFiles.length === 0) {
    throw new Error("Missing target_files");
  }

  for (let index = 0; index < targetFiles.length; index += 1) {
    const targetFile = targetFiles[index];
    const targetField = targetFields[index] || targetFields[0] || "";
    const targetPath = await resolveTargetPath(input.tenantPath, targetFile);
    if (!targetPath) {
      throw new Error(`Target file not found: ${targetFile}`);
    }

    const transform = input.question.transform_hint || "";
    if (!targetField && transform !== "to_offer_rows" && transform !== "map_to_usps") {
      throw new Error("Missing target_fields");
    }
    if (transform === "upsert_kv") {
      await upsertCsvKeyValue(targetPath, targetField, input.answer);
      input.report.written.push({ question_id: input.question.question_id, target_file: targetFile, target_field: targetField });
      continue;
    }

    if (transform === "to_offer_rows") {
      await addOfferRows(targetPath, input.answer, input.runProfileLanguage, input.report, input.question.question_id);
      continue;
    }

    if (transform === "map_to_usps") {
      await mapUsps(targetPath, input.answer, input.runProfileLanguage, input.report, input.question.question_id);
      continue;
    }

    if (transform === "to_rule_rows") {
      await addRuleRows(targetPath, input.answer, input.runProfileLanguage, input.report, input.question.question_id);
      continue;
    }

    if (transform === "parse_address") {
      await writeAddress(targetPath, targetField, input.answer, input.runProfileLanguage, input.report, input.question.question_id);
      continue;
    }

    if (transform === "to_location_entities") {
      await addLocationEntities(targetPath, input.answer, input.runProfileLanguage, input.report, input.question.question_id);
      continue;
    }

    if (transform === "split_comma_to_rows") {
      await addRowsForList(targetPath, targetField, input.answer, ",", input.report, input.question.question_id);
      continue;
    }

    const normalized = normalizeAnswer(input.answer, transform);
    await writeField(targetPath, targetField, normalized, input.pageId, input.report, input.question.question_id);
  }
}

async function resolveTargetPath(tenantPath: string, fileName: string): Promise<string | null> {
  const base = `${tenantPath}/data`;
  const matches: string[] = [];
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await import("fs/promises").then((fs) => fs.readdir(current, { withFileTypes: true }));
    for (const entry of entries) {
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === fileName) {
        matches.push(fullPath);
      }
    }
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return null;
}

async function writeField(
  path: string,
  field: string,
  value: string,
  pageId: string | undefined,
  report: IntakeResult,
  questionId: string
): Promise<void> {
  const headers = await readCsvHeaders(path);
  if (!headers.includes(field)) {
    throw new Error(`Target field not found: ${field}`);
  }
  const rows = await readCsvRows(path);
  if (rows.length === 0) {
    rows.push(buildEmptyRow(headers));
  }

  let updated = false;
  rows.forEach((row) => {
    if (pageId && row.page_id && row.page_id !== pageId) {
      return;
    }
    row[field] = value;
    updated = true;
  });

  if (!updated) {
    const row = buildEmptyRow(headers);
    row[field] = value;
    if (pageId && headers.includes("page_id")) {
      row.page_id = pageId;
    }
    rows.push(row);
  }

  await writeCsvRows(path, headers, rows);
  report.written.push({ question_id: questionId, target_file: path.split("/").pop() || "", target_field: field });
}

function normalizeAnswer(answer: string, transform: string): string {
  if (transform === "split_comma") {
    return answer
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .join(",");
  }
  if (transform === "split_lines") {
    return answer
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n");
  }
  return answer;
}

async function addOfferRows(
  path: string,
  answer: string,
  language: string,
  report: IntakeResult,
  questionId: string
): Promise<void> {
  const headers = await readCsvHeaders(path);
  requireHeaders(headers, ["offer_id", "language", "offer_name"]);
  const rows = await readCsvRows(path);
  const offers = answer
    .split(/,|\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  offers.forEach((offer) => {
    const row = buildEmptyRow(headers);
    row.offer_id = slugify(offer);
    row.language = language;
    row.offer_name = offer;
    rows.push(row);
  });

  await writeCsvRows(path, headers, rows);
  report.written.push({ question_id: questionId, target_file: path.split("/").pop() || "", target_field: "offer_name" });
}

async function mapUsps(
  path: string,
  answer: string,
  language: string,
  report: IntakeResult,
  questionId: string
): Promise<void> {
  const headers = await readCsvHeaders(path);
  requireHeaders(headers, ["offer_id", "language", "short_promise", "detailed_description"]);
  const rows = await readCsvRows(path);
  if (rows.length === 0) {
    const row = buildEmptyRow(headers);
    row.offer_id = "offer_default";
    row.language = language;
    rows.push(row);
  }
  const items = answer
    .split(/,|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const shortPromise = items[0] || "";
  const detailed = items.slice(1).join(", ");
  rows[0].short_promise = shortPromise;
  rows[0].detailed_description = detailed;
  await writeCsvRows(path, headers, rows);
  report.written.push({ question_id: questionId, target_file: path.split("/").pop() || "", target_field: "short_promise" });
}

async function addRuleRows(
  path: string,
  answer: string,
  language: string,
  report: IntakeResult,
  questionId: string
): Promise<void> {
  const headers = await readCsvHeaders(path);
  requireHeaders(headers, ["rule_id", "language", "scope", "severity", "rule_type", "rule_text"]);
  const rows = await readCsvRows(path);
  const items = answer
    .split(/,|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  items.forEach((item, index) => {
    const row = buildEmptyRow(headers);
    row.rule_id = `${questionId}_${index + 1}`.toLowerCase();
    row.language = language;
    row.scope = "global";
    row.severity = "warn";
    row.rule_type = "intake";
    row.rule_text = item;
    rows.push(row);
  });
  await writeCsvRows(path, headers, rows);
  report.written.push({ question_id: questionId, target_file: path.split("/").pop() || "", target_field: "rule_text" });
}

async function writeAddress(
  path: string,
  field: string,
  answer: string,
  language: string,
  report: IntakeResult,
  questionId: string
): Promise<void> {
  const headers = await readCsvHeaders(path);
  requireHeaders(headers, ["street", "postal_code", "city", "country"]);
  const rows = await readCsvRows(path);
  if (rows.length === 0) {
    const row = buildEmptyRow(headers);
    row.entity_id = "entity_address";
    row.entity_type = "organization";
    row.name = "Unknown";
    row.language = language;
    rows.push(row);
  }
  const parts = answer.split(",").map((item) => item.trim());
  const [street, postal_code, city, country] = parts;
  rows[0].street = street || rows[0].street || "";
  rows[0].postal_code = postal_code || rows[0].postal_code || "";
  rows[0].city = city || rows[0].city || "";
  rows[0].country = country || rows[0].country || "";
  await writeCsvRows(path, headers, rows);
  report.written.push({ question_id: questionId, target_file: path.split("/").pop() || "", target_field: field });
}

async function addLocationEntities(
  path: string,
  answer: string,
  language: string,
  report: IntakeResult,
  questionId: string
): Promise<void> {
  const headers = await readCsvHeaders(path);
  requireHeaders(headers, ["entity_id", "entity_type", "name", "address", "phone"]);
  const rows = await readCsvRows(path);
  const entries = answer
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  entries.forEach((entry, index) => {
    const row = buildEmptyRow(headers);
    row.entity_id = `location_${index + 1}`;
    row.entity_type = "location";
    row.name = `Location ${index + 1}`;
    row.language = language;
    const parts = entry.split("|").map((part) => part.trim());
    row.address = parts[0] || entry;
    row.phone = parts[1] || "";
    rows.push(row);
  });
  await writeCsvRows(path, headers, rows);
  report.written.push({ question_id: questionId, target_file: path.split("/").pop() || "", target_field: "address" });
}

async function addRowsForList(
  path: string,
  field: string,
  answer: string,
  delimiter: string,
  report: IntakeResult,
  questionId: string
): Promise<void> {
  const headers = await readCsvHeaders(path);
  requireHeaders(headers, [field]);
  const rows = await readCsvRows(path);
  const items = answer
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  items.forEach((item) => {
    const row = buildEmptyRow(headers);
    row[field] = item;
    rows.push(row);
  });
  await writeCsvRows(path, headers, rows);
  report.written.push({ question_id: questionId, target_file: path.split("/").pop() || "", target_field: field });
}

function buildEmptyRow(headers: string[]): Record<string, string> {
  return headers.reduce<Record<string, string>>((acc, header) => {
    acc[header] = "";
    return acc;
  }, {});
}

function requireHeaders(headers: string[], required: string[]): void {
  const missing = required.filter((field) => !headers.includes(field));
  if (missing.length > 0) {
    throw new Error(`Target fields missing: ${missing.join(", ")}`);
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "offer"
  );
}

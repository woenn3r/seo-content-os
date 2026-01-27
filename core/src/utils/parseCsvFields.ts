import { readJsonFile } from "./fs";

export type ParsingRule = {
  type: "string" | "array";
  delimiter?: string;
  trim?: boolean;
  allow_empty?: boolean;
};

export type ParsingRules = Record<string, ParsingRule>;

export async function loadParsingRules(repoRoot: string): Promise<ParsingRules> {
  const path = `${repoRoot}/seo_content_os_scaffold_v4/shared/contracts/v1/csv_field_parsing_rules.json`;
  return readJsonFile<ParsingRules>(path);
}

export function parseCsvFields<T extends Record<string, string>>(
  row: T,
  rules: ParsingRules
): Record<string, unknown> {
  const parsed: Record<string, unknown> = { ...row };

  for (const [field, rule] of Object.entries(rules)) {
    const raw = row[field] ?? "";
    if (!raw && !rule.allow_empty) {
      delete parsed[field];
      continue;
    }

    if (rule.type === "array") {
      const delimiter = rule.delimiter ?? ",";
      const normalized = raw ? raw.replace(/\\n/g, "\n") : "";
      const items = normalized
        ? normalized.split(delimiter).map((item) => (rule.trim ? item.trim() : item))
        : [];
      const cleaned = rule.allow_empty ? items : items.filter(Boolean);
      if (cleaned.length > 0 || rule.allow_empty) {
        parsed[field] = cleaned;
      } else {
        delete parsed[field];
      }
      continue;
    }

    if (raw || rule.allow_empty) {
      parsed[field] = raw;
    } else {
      delete parsed[field];
    }
  }

  return parsed;
}

export function serializeCsvRow(
  columns: string[],
  values: Record<string, unknown>,
  rules: ParsingRules
): string {
  return columns
    .map((column) => formatCsvField(column, values[column], rules))
    .join(",");
}

function formatCsvField(
  field: string,
  value: unknown,
  rules: ParsingRules
): string {
  const rule = rules[field];
  if (rule && rule.type === "array" && Array.isArray(value)) {
    const delimiter = rule.delimiter ?? ",";
    const serialized = value.map((item) => String(item)).join(delimiter);
    return escapeCsv(serialized);
  }

  if (value === undefined || value === null) {
    return "";
  }

  return escapeCsv(String(value));
}

function escapeCsv(value: string): string {
  let escaped = value;
  if (escaped.includes("\"")) {
    escaped = escaped.replace(/\"/g, "\"\"");
  }
  if (escaped.includes(",") || escaped.includes("\n")) {
    return `"${escaped}"`;
  }
  return escaped;
}

import { parse } from "csv-parse/sync";
import { ensureDir, readFile, writeFile } from "./fs";

export type CsvRow = Record<string, string>;

export async function readCsvRows(path: string): Promise<CsvRow[]> {
  const raw = await readFile(path);
  const records = parseCsv(raw);
  if (records.length === 0) {
    return [];
  }

  const headers = records[0];
  return records.slice(1).map((values) => {
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

export async function readCsvHeaders(path: string): Promise<string[]> {
  const raw = await readFile(path);
  const records = parseCsv(raw);
  return records[0] || [];
}

export async function writeCsvRows(
  path: string,
  headers: string[],
  rows: Array<Record<string, string>>
): Promise<void> {
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCsv(row[header] || "")).join(","));
  });
  await ensureDir(path);
  await writeFile(path, `${lines.join("\n")}\n`);
}

export async function readCsvKeyValue(path: string): Promise<Record<string, string>> {
  const rows = await readCsvRows(path);
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key || "";
    if (!key) {
      continue;
    }
    result[key] = row.value || "";
  }
  return result;
}

export async function upsertCsvKeyValue(
  path: string,
  key: string,
  value: string,
  notes?: string
): Promise<void> {
  const rows = await readCsvRows(path);
  let updated = false;

  const nextRows = rows.map((row) => {
    if (row.key === key) {
      updated = true;
      return { key, value, notes: notes ?? row.notes ?? "" };
    }
    return row;
  });

  if (!updated) {
    nextRows.push({ key, value, notes: notes ?? "" });
  }

  const lines = ["key,value,notes"];
  nextRows.forEach((row) => {
    lines.push([row.key || "", row.value || "", row.notes || ""].map(escapeCsv).join(","));
  });

  await ensureDir(path);
  await writeFile(path, `${lines.join("\n")}\n`);
}


function parseCsvLine(line: string): string[] {
  return parseCsv(line)[0] || [];
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

function parseCsv(raw: string): string[][] {
  if (!raw.trim()) {
    return [];
  }

  return parse(raw, {
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];
}

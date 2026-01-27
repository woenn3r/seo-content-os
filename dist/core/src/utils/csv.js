import { readFile } from "./fs";
export async function readCsvRows(path) {
    const raw = await readFile(path);
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
        return [];
    }
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] ?? "";
        });
        return row;
    });
}
export async function readCsvKeyValue(path) {
    const rows = await readCsvRows(path);
    const result = {};
    for (const row of rows) {
        const key = row.key || "";
        if (!key) {
            continue;
        }
        result[key] = row.value || "";
    }
    return result;
}
function parseCsvLine(line) {
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
            }
            else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (char === "," && !inQuotes) {
            values.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    values.push(current);
    return values;
}

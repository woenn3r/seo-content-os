import { promises as fs } from "fs";
import { dirname } from "path";

export async function readFile(path: string): Promise<string> {
  return fs.readFile(path, "utf8");
}

export async function writeFile(path: string, contents: string): Promise<void> {
  await fs.writeFile(path, contents, "utf8");
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path);
  return JSON.parse(raw) as T;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
}

export async function copyDir(source: string, destination: string): Promise<void> {
  // Node 16+ supports fs.cp; fallback logic can be added later.
  await fs.cp(source, destination, { recursive: true });
}

export async function listFiles(path: string): Promise<string[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

export async function copyFile(source: string, destination: string): Promise<void> {
  await ensureDir(destination);
  await fs.copyFile(source, destination);
}

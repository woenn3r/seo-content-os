import { promises as fs } from "fs";
import { dirname } from "path";
export async function readFile(path) {
    return fs.readFile(path, "utf8");
}
export async function writeFile(path, contents) {
    await fs.writeFile(path, contents, "utf8");
}
export async function readJsonFile(path) {
    const raw = await readFile(path);
    return JSON.parse(raw);
}
export async function fileExists(path) {
    try {
        await fs.access(path);
        return true;
    }
    catch {
        return false;
    }
}
export async function ensureDir(path) {
    await fs.mkdir(dirname(path), { recursive: true });
}
export async function copyDir(source, destination) {
    // Node 16+ supports fs.cp; fallback logic can be added later.
    await fs.cp(source, destination, { recursive: true });
}
export async function listFiles(path) {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}
export async function copyFile(source, destination) {
    await ensureDir(destination);
    await fs.copyFile(source, destination);
}

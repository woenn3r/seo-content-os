import { execSync } from "node:child_process";

const SKIP_PREFIXES = ["secrets/"];
const PATTERNS = [
  { name: "PRIVATE_KEY", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GOOGLE_API_KEY", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "OPENAI_API_KEY", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "SLACK_TOKEN", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "GITHUB_TOKEN", regex: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "GITLAB_TOKEN", regex: /\bglpat-[A-Za-z0-9\-_]{10,}\b/ },
  { name: "CLIENT_SECRET", regex: /client_secret"\s*:\s*"[^"\n]+"/i },
  { name: "REFRESH_TOKEN", regex: /refresh_token"\s*:\s*"[^"\n]+"/i },
  { name: "ACCESS_TOKEN", regex: /access_token"\s*:\s*"[^"\n]+"/i },
  { name: "CLIENT_SECRET_ENV", regex: /client_secret\s*=\s*\S+/i },
  { name: "REFRESH_TOKEN_ENV", regex: /refresh_token\s*=\s*\S+/i }
];

function listStagedFiles() {
  const out = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" }).trim();
  if (!out) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function isSkipped(path) {
  return SKIP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function readStagedFile(path) {
  try {
    return execSync(`git show :${path}`, { encoding: "utf8" });
  } catch {
    return "";
  }
}

let failed = false;
const files = listStagedFiles();
for (const file of files) {
  if (isSkipped(file)) continue;
  const content = readStagedFile(file);
  if (!content) continue;
  for (const { name, regex } of PATTERNS) {
    if (regex.test(content)) {
      console.error(`Secret scan failed: ${name} detected in ${file}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("Commit blocked. Remove secrets or move them under secrets/ (gitignored)." );
  process.exit(1);
}

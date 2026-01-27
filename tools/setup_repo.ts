import { execSync } from "node:child_process";

function run(cmd: string) {
  execSync(cmd, { stdio: "inherit" });
}

function runCapture(cmd: string) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function ensureHooksPath() {
  const desired = ".githooks";
  const current = runCapture("git config --get core.hooksPath || true");
  if (current !== desired) {
    run(`git config core.hooksPath ${desired}`);
  }
}

function validateRegistries() {
  run("npm run validate:registries");
}

function ensureNoTrackedSecrets() {
  const tracked = runCapture("git ls-files");
  const secrets = tracked
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("secrets/"));
  if (secrets.length > 0) {
    console.error("Found tracked secrets/ files:\n" + secrets.join("\n"));
    process.exit(1);
  }
}

function main() {
  ensureHooksPath();
  validateRegistries();
  ensureNoTrackedSecrets();
  console.log("setup.ok");
}

main();

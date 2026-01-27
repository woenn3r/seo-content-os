import { execSync } from "node:child_process";

function run(cmd: string) {
  execSync(cmd, { stdio: "inherit" });
}

// Remove .DS_Store files excluding node_modules
run("find . -name .DS_Store -not -path './node_modules/*' -print -delete");
console.log("cleanup.mac.ok");

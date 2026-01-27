import dotenv from "dotenv";
import { existsSync } from "fs";

export function loadEnv(): void {
  const secretsPath = `${process.cwd()}/secrets/openai.env`;
  if (existsSync(secretsPath)) {
    dotenv.config({ path: secretsPath, override: true });
    return;
  }
  dotenv.config({ override: true });
}

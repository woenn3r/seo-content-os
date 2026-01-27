import { loadEnv } from "../core/src/utils/loadEnv";

loadEnv();

const hasKey = Boolean(process.env.OPENAI_API_KEY);
console.log(hasKey ? "true" : "false");

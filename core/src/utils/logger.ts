const isVerbose =
  process.env.DEBUG === "1" ||
  process.env.DEBUG === "true" ||
  process.argv.includes("--verbose");

export const logger = {
  info(event: string, payload?: Record<string, unknown>) {
    if (payload) {
      console.log(`[INFO] ${event}`, payload);
      return;
    }
    console.log(`[INFO] ${event}`);
  },
  warn(event: string, payload?: Record<string, unknown>) {
    if (payload) {
      console.warn(`[WARN] ${event}`, payload);
      return;
    }
    console.warn(`[WARN] ${event}`);
  },
  error(event: string, payload?: Record<string, unknown>) {
    if (payload) {
      console.error(`[ERROR] ${event}`, payload);
      return;
    }
    console.error(`[ERROR] ${event}`);
  },
  debug(event: string, payload?: Record<string, unknown>) {
    if (!isVerbose) {
      return;
    }
    if (payload) {
      console.log(`[DEBUG] ${event}`, payload);
      return;
    }
    console.log(`[DEBUG] ${event}`);
  },
};

import { readCsvKeyValue, readCsvRows } from "../utils/csv";
import { ensureDir, fileExists, readFile, readJsonFile, writeFile } from "../utils/fs";
import { logger } from "../utils/logger";
import { RunProfile } from "../config/loadRunProfile";

type ConnectorRegistryRow = {
  connector_id: string;
  scope?: string;
  required_by_pack_ids?: string;
  required_by_modes?: string;
  secrets_path_template?: string;
  config_keys?: string;
  test_endpoint?: string;
  failure_policy_default?: string;
};

type PreflightInput = {
  repoRoot: string;
  tenantPath: string;
  runDir: string;
  runId: string;
  runProfile: RunProfile;
  resolvedPacks: { activePacks: string[] };
  step?: "ingest" | "analyze" | "generate" | "qa" | "export";
};

type ConnectorCheck = {
  connector_id: string;
  scope: string;
  required: boolean;
  effective_required: boolean;
  enabled_by_config: boolean;
  required_by_mode: boolean;
  required_by_packs: string[];
  secrets_path?: string;
  status: "connected" | "missing" | "invalid" | "disabled";
  message?: string;
  checked_at: string;
};

type PreflightReport = {
  run_id: string;
  tenant: string;
  mode: string;
  step?: string;
  status: "PASS" | "WARN" | "BLOCK";
  created_at: string;
  connectors: ConnectorCheck[];
  warnings: string[];
  errors: string[];
  intentionally_disabled_connectors: string[];
  allow_missing_data: boolean;
  registry_path: string;
};

export async function checkConnectors(input: PreflightInput): Promise<{
  status: "PASS" | "WARN" | "BLOCK";
  reportPath: string;
  report: PreflightReport;
}> {
  const registryPath = `${input.repoRoot}/seo_content_os_scaffold_v4/shared/connectors/v1/connectors_registry.csv`;
  const registry = (await readCsvRows(registryPath)) as ConnectorRegistryRow[];
  const tenantName = input.tenantPath.split("/").pop() || "tenant";
  const projectConfigPath = `${input.tenantPath}/data/01_project/project_config/v1/01_project_config.csv`;
  const projectConfig = await readCsvKeyValue(projectConfigPath);
  const mode = input.runProfile.mode || "draft";

  const warnings: string[] = [];
  const errors: string[] = [];
  const intentionallyDisabled: string[] = [];
  const connectors: ConnectorCheck[] = [];

  for (const row of registry) {
    const connectorId = row.connector_id;
    if (!connectorId) {
      continue;
    }

    const requiredByPacks = parseList(row.required_by_pack_ids).filter((pack) =>
      input.resolvedPacks.activePacks.includes(pack)
    );
    const requiredByMode = parseList(row.required_by_modes).includes(mode);
    const configSpecs = parseConfigKeys(row.config_keys);
    const enabledByConfig = configSpecs.some((spec) => matchesConfig(projectConfig, spec));
    const explicitlyDisabled = configSpecs.some((spec) => isExplicitlyDisabled(projectConfig, spec.key));

    if (explicitlyDisabled) {
      intentionallyDisabled.push(connectorId);
    }

    let required = enabledByConfig || requiredByPacks.length > 0 || requiredByMode;
    let active = required;
    const effectiveRequired =
      requiredByMode || requiredByPacks.length > 0 || (required && enabledByConfig);

    if (connectorId === "openai") {
      required = requiredByMode;
      active = required;
    }

    if (!active) {
      if (connectorId === "openai" && requiredByMode && !enabledByConfig && mode === "strict_production") {
        errors.push("openai: required by mode but not enabled");
      }
      connectors.push({
        connector_id: connectorId,
        scope: row.scope || "tenant",
        required,
        effective_required: effectiveRequired,
        enabled_by_config: enabledByConfig,
        required_by_mode: requiredByMode,
        required_by_packs: requiredByPacks,
        secrets_path: resolveSecretsPath(row.secrets_path_template, tenantName),
        status: "disabled",
        message: explicitlyDisabled ? "disabled_by_config" : "not_enabled",
        checked_at: new Date().toISOString(),
      });
      continue;
    }

    const secretsPath = resolveSecretsPath(row.secrets_path_template, tenantName);
    const checkResult = await checkConnector(connectorId, secretsPath, row.test_endpoint, input.repoRoot);
    connectors.push({
      connector_id: connectorId,
      scope: row.scope || "tenant",
      required,
      effective_required: effectiveRequired,
      enabled_by_config: enabledByConfig,
      required_by_mode: requiredByMode,
      required_by_packs: requiredByPacks,
      secrets_path: secretsPath,
      status: checkResult.status,
      message: checkResult.message,
      checked_at: new Date().toISOString(),
    });

    if (checkResult.status === "invalid") {
      errors.push(`${connectorId}: ${checkResult.message || "invalid_credentials"}`);
      continue;
    }

    if (checkResult.status === "missing") {
      if (mode === "strict_production" && (effectiveRequired || required)) {
        errors.push(`${connectorId}: missing credentials`);
      } else if (connectorId === "gsc" || connectorId === "rybbit") {
        warnings.push(`${connectorId}: missing credentials`);
      } else if (required) {
        warnings.push(`${connectorId}: missing credentials`);
      }
    }
  }

  const status = errors.length > 0 ? "BLOCK" : warnings.length > 0 ? "WARN" : "PASS";
  const report: PreflightReport = {
    run_id: input.runId,
    tenant: tenantName,
    mode,
    step: input.step,
    status,
    created_at: new Date().toISOString(),
    connectors,
    warnings,
    errors,
    intentionally_disabled_connectors: Array.from(new Set(intentionallyDisabled)),
    allow_missing_data: mode === "strict_production" ? false : Array.from(new Set(intentionallyDisabled)).length > 0,
    registry_path: registryPath,
  };

  const reportPath = `${input.runDir}/${tenantName}/preflight_report.json`;
  await ensureDir(reportPath);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  logger.info("preflight.done", { status, reportPath, errors: errors.length, warnings: warnings.length });

  return { status, reportPath, report };
}

function parseList(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseConfigKeys(value?: string): Array<{ key: string; value?: string }> {
  if (!value) {
    return [];
  }
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, val] = entry.split("=").map((part) => part.trim());
      return { key, value: val || undefined };
    });
}

function matchesConfig(config: Record<string, string>, spec: { key: string; value?: string }): boolean {
  const raw = (config[spec.key] || "").trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (!spec.value) {
    return raw !== "no" && raw !== "false" && raw !== "0";
  }
  return raw === spec.value.toLowerCase();
}

function isExplicitlyDisabled(config: Record<string, string>, key: string): boolean {
  const raw = (config[key] || "").trim().toLowerCase();
  return raw === "no" || raw === "false" || raw === "0";
}

function resolveSecretsPath(template: string | undefined, tenant: string): string | undefined {
  if (!template) {
    return undefined;
  }
  return template.replace("{tenant}", tenant);
}

async function checkConnector(
  connectorId: string,
  secretsPath: string | undefined,
  testEndpoint: string | undefined,
  repoRoot: string
): Promise<{ status: "connected" | "missing" | "invalid"; message?: string }> {
  switch (connectorId) {
    case "openai":
      return checkOpenAi(testEndpoint);
    case "gsc":
      return checkGsc(secretsPath, testEndpoint, repoRoot);
    case "rybbit":
      return checkRybbit(secretsPath);
    default:
      return checkGenericSecrets(secretsPath);
  }
}

async function checkOpenAi(
  testEndpoint: string | undefined
): Promise<{ status: "connected" | "missing" | "invalid"; message?: string }> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return { status: "missing", message: "OPENAI_API_KEY missing" };
  }
  if (!testEndpoint) {
    return { status: "connected" };
  }

  const response = await fetchWithTimeout(testEndpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response) {
    return { status: "invalid", message: "openai test request failed" };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: "invalid", message: `openai auth failed (${response.status})` };
  }
  if (response.ok) {
    return { status: "connected" };
  }
  return { status: "invalid", message: `openai test failed (${response.status})` };
}

async function checkGsc(
  secretsPath: string | undefined,
  testEndpoint: string | undefined,
  repoRoot: string
): Promise<{ status: "connected" | "missing" | "invalid"; message?: string }> {
  if (!secretsPath) {
    return { status: "missing", message: "missing secrets path" };
  }
  if (!(await fileExists(secretsPath))) {
    return { status: "missing", message: "token file missing" };
  }

  let tokenData: Record<string, any>;
  try {
    tokenData = await readJsonFile<Record<string, any>>(secretsPath);
  } catch {
    return { status: "invalid", message: "token file invalid json" };
  }

  const refreshToken = tokenData.refresh_token || tokenData.refreshToken;
  const clientId = tokenData.client_id || tokenData.clientId;
  const clientSecret = tokenData.client_secret || tokenData.clientSecret;
  const tokenUri = tokenData.token_uri || "https://oauth2.googleapis.com/token";

  if (!refreshToken) {
    return { status: "invalid", message: "refresh_token missing" };
  }
  if (!clientId || !clientSecret) {
    return { status: "invalid", message: "client credentials missing" };
  }

  const refreshResult = await refreshAccessToken(tokenUri, clientId, clientSecret, refreshToken);
  if (!refreshResult.accessToken) {
    await logGscClientIds(repoRoot, secretsPath, tokenData);
    const message =
      refreshResult.errorClass === "network"
        ? "gsc connector unreachable (network)"
        : refreshResult.errorClass === "config"
          ? "gsc connector misconfigured"
          : refreshResult.errorClass === "auth"
            ? "refresh token invalid"
            : "gsc refresh failed";
    return { status: "invalid", message };
  }
  if (!testEndpoint) {
    return { status: "connected" };
  }

  const response = await fetchWithTimeout(testEndpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${refreshResult.accessToken}` },
  });
  if (!response) {
    return { status: "invalid", message: "gsc test request failed" };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: "invalid", message: `gsc auth failed (${response.status})` };
  }
  if (response.ok) {
    return { status: "connected" };
  }
  return { status: "invalid", message: `gsc test failed (${response.status})` };
}

async function refreshAccessToken(
  tokenUri: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{
  accessToken?: string;
  errorClass?: "network" | "auth" | "config" | "unknown";
  errorMessage?: string;
  status?: number;
}> {
  logger.debug("gsc.refresh.request", {
    token_uri: tokenUri,
    payload_keys_present: {
      client_id: !!clientId,
      client_secret: !!clientSecret,
      refresh_token: !!refreshToken,
      grant_type: true,
    },
  });

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await delay(500);
    }

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const response = await fetch(tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      if (!response.ok) {
        let error: string | undefined;
        let errorDescription: string | undefined;
        try {
          const payload = (await response.json()) as { error?: string; error_description?: string };
          error = payload.error;
          errorDescription = payload.error_description;
        } catch {
          error = undefined;
          errorDescription = undefined;
        }

        const errorClass =
          error === "invalid_grant"
            ? "auth"
            : error === "invalid_client"
              ? "config"
              : response.status === 400 || response.status === 401
                ? "auth"
                : "unknown";

        logger.info("gsc.refresh.response", {
          attempt,
          duration_ms: durationMs,
          error_class: errorClass,
        });
        logger.debug("gsc.refresh.response.detail", {
          attempt,
          duration_ms: durationMs,
          status: response.status,
          error: error || "missing",
          error_description: errorDescription || "missing",
          error_class: errorClass,
        });
        return { errorClass, errorMessage: error || errorDescription, status: response.status };
      }

      const payload = (await response.json()) as { access_token?: string };
      logger.info("gsc.refresh.response", {
        attempt,
        duration_ms: durationMs,
        error_class: "ok",
      });
      return { accessToken: payload.access_token || undefined };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorClass = classifyNetworkError(err);
      logger.info("gsc.refresh.response", {
        attempt,
        duration_ms: durationMs,
        error_class: errorClass,
      });
      logger.debug("gsc.refresh.response.detail", {
        attempt,
        duration_ms: durationMs,
        status: "no_response",
        error_class: errorClass,
        error_code: err?.code || err?.cause?.code || "missing",
        error_name: err?.name || "missing",
      });
      if (attempt === maxAttempts) {
        return { errorClass };
      }
    }
  }

  return { errorClass: "unknown" };
}

async function checkRybbit(
  secretsPath: string | undefined
): Promise<{ status: "connected" | "missing" | "invalid"; message?: string }> {
  if (!secretsPath) {
    return { status: "missing", message: "missing secrets path" };
  }
  if (!(await fileExists(secretsPath))) {
    return { status: "missing", message: "token file missing" };
  }

  const raw = await readFile(secretsPath);
  const trimmed = raw.trim();
  if (!trimmed) {
    return { status: "invalid", message: "token file empty" };
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      const token = parsed.api_key || parsed.token || parsed.rybbit_api_key || parsed.rybbit_token;
      if (token) {
        return { status: "connected" };
      }
      return { status: "invalid", message: "token missing in json" };
    } catch {
      return { status: "invalid", message: "token file invalid json" };
    }
  }

  const env = parseEnv(raw);
  const token = env.RYBBIT_API_KEY || env.RYBBIT_TOKEN;
  if (!token) {
    return { status: "invalid", message: "token missing in env" };
  }
  return { status: "connected" };
}

async function checkGenericSecrets(
  secretsPath: string | undefined
): Promise<{ status: "connected" | "missing" | "invalid"; message?: string }> {
  if (!secretsPath) {
    return { status: "missing", message: "missing secrets path" };
  }
  if (!(await fileExists(secretsPath))) {
    return { status: "missing", message: "secret file missing" };
  }
  return { status: "connected" };
}

function parseEnv(raw: string): Record<string, string> {
  const lines = raw.split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^\"|\"$/g, "");
    env[key] = value;
  }
  return env;
}

function classifyNetworkError(err: any): "network" | "unknown" {
  const code = err?.code || err?.cause?.code;
  const name = err?.name;
  if (
    name === "AbortError" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return "network";
  }
  return "unknown";
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logGscClientIds(
  repoRoot: string,
  tokenPath: string,
  tokenData: Record<string, any>
): Promise<void> {
  const oauthClientPath = `${repoRoot}/secrets/google_oauth_client.json`;
  let oauthClientId: string | undefined;
  if (await fileExists(oauthClientPath)) {
    try {
      const clientData = await readJsonFile<Record<string, any>>(oauthClientPath);
      oauthClientId =
        clientData?.installed?.client_id || clientData?.web?.client_id || clientData?.client_id;
    } catch {
      oauthClientId = undefined;
    }
  }

  const tokenClientId = tokenData.client_id || tokenData.clientId;
  logger.debug("gsc.debug", {
    oauth_client_path: oauthClientPath,
    oauth_client_id: oauthClientId || "missing",
    token_path: tokenPath,
    token_client_id: tokenClientId || "missing",
  });
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 8000
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

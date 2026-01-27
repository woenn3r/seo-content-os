import { createServer } from "http";
import { randomBytes } from "crypto";
import { readJsonFile, writeFile, ensureDir } from "../core/src/utils/fs";
import { upsertCsvKeyValue } from "../core/src/utils/csv";

type OAuthClient = {
  client_id: string;
  client_secret: string;
  auth_uri?: string;
  token_uri?: string;
  redirect_uris?: string[];
};

const args = process.argv.slice(2);
const tenantArg = getArgValue(args, "--tenant");
const siteUrl = getArgValue(args, "--site_url");
const clientPath = getArgValue(args, "--client") || `${process.cwd()}/secrets/google_oauth_client.json`;
const portArg = getArgValue(args, "--port");
const explicitRedirect = getArgValue(args, "--redirect_uri");

if (!tenantArg || !siteUrl) {
  throw new Error("Usage: --tenant <domain|path> --site_url <https://...> [--client <path>] [--port <port>]");
}

const repoRoot = process.cwd();
const tenantPath = tenantArg.includes("/")
  ? tenantArg
  : `${repoRoot}/seo_content_os_scaffold_v4/tenants/${tenantArg}`;
const tenantName = tenantPath.split("/").pop() || "tenant";

const clientData = await readJsonFile<Record<string, any>>(clientPath);
const client = extractClient(clientData);
const authUri = client.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUri = client.token_uri || "https://oauth2.googleapis.com/token";

let redirectUri = explicitRedirect || pickRedirectUri(client.redirect_uris || [], portArg);
if (!redirectUri) {
  throw new Error(
    `No localhost redirect URI found. Add http://localhost:<port>/oauth2callback to ${clientPath} or pass --redirect_uri.`
  );
}

const redirectUrl = new URL(redirectUri);
const port = Number(redirectUrl.port || portArg || 8787);
if (!redirectUrl.port) {
  redirectUrl.port = String(port);
  redirectUri = redirectUrl.toString();
}

const state = randomBytes(16).toString("hex");
const scope = "https://www.googleapis.com/auth/webmasters.readonly";
const authUrl = new URL(authUri);
authUrl.searchParams.set("client_id", client.client_id);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", scope);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("include_granted_scopes", "true");
authUrl.searchParams.set("state", state);

const code = await waitForOAuthCode(port, state);

const tokenResponse = await exchangeCodeForToken(tokenUri, client, redirectUri, code);
if (!tokenResponse.refresh_token) {
  throw new Error("No refresh_token returned. Ensure consent is granted and rerun the flow.");
}

const tokenPayload = {
  refresh_token: tokenResponse.refresh_token,
  access_token: tokenResponse.access_token,
  token_type: tokenResponse.token_type,
  scope: tokenResponse.scope,
  expires_in: tokenResponse.expires_in,
  obtained_at: new Date().toISOString(),
  connected_at: new Date().toISOString(),
  site_url: siteUrl,
  client_id: client.client_id,
  client_secret: client.client_secret,
  token_uri: tokenUri,
};

const tokenPath = `${repoRoot}/secrets/tenants/${tenantName}/google_gsc_token.json`;
await ensureDir(tokenPath);
await writeFile(tokenPath, `${JSON.stringify(tokenPayload, null, 2)}\n`);

const projectConfigPath = `${tenantPath}/data/01_project/project_config/v1/01_project_config.csv`;
await upsertCsvKeyValue(projectConfigPath, "gsc_enabled", "yes");
await upsertCsvKeyValue(projectConfigPath, "gsc_site_url", siteUrl);
await upsertCsvKeyValue(projectConfigPath, "gsc_connected", "yes");
await upsertCsvKeyValue(projectConfigPath, "gsc_connected_at", new Date().toISOString());

console.log(`gsc.connected tenant=${tenantName} site=${siteUrl}`);
console.log(`gsc.token.saved ${tokenPath}`);

function getArgValue(argsList: string[], key: string): string | undefined {
  const index = argsList.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return argsList[index + 1];
}

function extractClient(raw: Record<string, any>): OAuthClient {
  const source = raw.installed || raw.web || raw;
  if (!source.client_id || !source.client_secret) {
    throw new Error("OAuth client missing client_id/client_secret.");
  }
  return {
    client_id: source.client_id,
    client_secret: source.client_secret,
    auth_uri: source.auth_uri,
    token_uri: source.token_uri,
    redirect_uris: source.redirect_uris || [],
  };
}

function pickRedirectUri(redirects: string[], portArg?: string): string | null {
  if (portArg) {
    const candidate = `http://localhost:${portArg}/oauth2callback`;
    if (redirects.includes(candidate)) {
      return candidate;
    }
  }
  const localhostRedirect = redirects.find((uri) => uri.startsWith("http://localhost"));
  if (localhostRedirect) {
    return localhostRedirect;
  }
  return null;
}

function waitForOAuthCode(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      if (url.pathname !== "/oauth2callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!code || state !== expectedState) {
        res.statusCode = 400;
        res.end("OAuth failed. Close this tab and retry.");
        server.close();
        reject(new Error("OAuth callback missing code or invalid state."));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end("<h2>Connected. You can close this tab.</h2>");
      server.close();
      resolve(code);
    });

    server.on("error", (err) => reject(err));
    server.listen(port, () => {
      console.log("Open this URL in your browser to connect Google Search Console:");
      console.log(String(authUrl));
    });
  });
}

async function exchangeCodeForToken(
  tokenUri: string,
  client: OAuthClient,
  redirectUri: string,
  code: string
): Promise<Record<string, any>> {
  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code,
  });
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }
  return (await response.json()) as Record<string, any>;
}

import { createHash } from "crypto";
import { readCsvRows } from "../utils/csv";
import { ensureDir, fileExists, readFile, readJsonFile, writeFile } from "../utils/fs";
import { OpenAIClient } from "../clients/openai";

type VectorStoreState = {
  vector_store_id?: string;
  file_id?: string;
  content_hash?: string;
  updated_at?: string;
};

type RetrievalResult = {
  summary: string;
  citations: Array<{ source: string; snippet: string }>;
};

const RAG_STATE_PATH = "data/02_ingest/rag/vector_store.json";
const RAG_BUNDLE_PATH = "data/02_ingest/rag/tenant_bundle.txt";
const SNAPSHOT_PATH = "data/02_ingest/site_content_snapshot/v1/07_site_content_snapshot.csv";
const OFFER_PATH = "data/01_project/offers/v1/04_offer_catalog.csv";
const BRAND_VOICE_PATH = "data/01_project/brand_voice/v1/02_brand_voice_rules.csv";

export async function ensureTenantVectorStore(tenantPath: string): Promise<VectorStoreState> {
  const bundle = await buildBundle(tenantPath);
  const hash = createHash("sha256").update(bundle).digest("hex");
  const statePath = `${tenantPath}/${RAG_STATE_PATH}`;
  let state: VectorStoreState = {};

  if (await fileExists(statePath)) {
    state = await readJsonFile<VectorStoreState>(statePath);
    if (state.content_hash === hash && state.vector_store_id && state.file_id) {
      return state;
    }
  }

  const bundlePath = `${tenantPath}/${RAG_BUNDLE_PATH}`;
  await ensureDir(bundlePath);
  await writeFile(bundlePath, bundle);

  try {
    const client = OpenAIClient.fromEnv();
    const vectorStoreId = state.vector_store_id || (await client.createVectorStore(`tenant_${slugify(tenantPath)}`));
    const fileId = await client.uploadFile(bundle, "tenant_bundle.txt");
    await client.attachFileToVectorStore(vectorStoreId, fileId);
    state = {
      vector_store_id: vectorStoreId,
      file_id: fileId,
      content_hash: hash,
      updated_at: new Date().toISOString(),
    };
  } catch {
    state = {
      vector_store_id: state.vector_store_id,
      file_id: state.file_id,
      content_hash: hash,
      updated_at: new Date().toISOString(),
    };
  }

  await ensureDir(statePath);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export async function retrieveTenantSummary(
  tenantPath: string,
  query: string,
  model: string
): Promise<{ result: RetrievalResult; usage: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
  const state = await ensureTenantVectorStore(tenantPath);
  if (state.vector_store_id) {
    try {
      const client = OpenAIClient.fromEnv();
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["summary", "citations"],
        properties: {
          summary: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["source", "snippet"],
              properties: {
                source: { type: "string" },
                snippet: { type: "string" },
              },
            },
          },
        },
      };
      const response = await client.responsesJson<RetrievalResult>({
        model,
        instructions: "You are a retrieval assistant. Use file_search results only.",
        prompt: `Retrieve the most relevant context for: ${query}`,
        jsonSchema: { name: "retrieval_summary", schema, strict: true },
        tools: [{ type: "file_search", vector_store_ids: [state.vector_store_id] }],
      });
      return { result: response.data, usage: response.usage };
    } catch {
      // Fall through to local retrieval.
    }
  }

  const bundle = await readFile(`${tenantPath}/${RAG_BUNDLE_PATH}`);
  const fallback = localRetrieve(bundle, query);
  return {
    result: fallback,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

async function buildBundle(tenantPath: string): Promise<string> {
  const parts: string[] = [];
  parts.push(await renderCsv(`${tenantPath}/${OFFER_PATH}`, "Offer Catalog"));
  parts.push(await renderCsv(`${tenantPath}/${BRAND_VOICE_PATH}`, "Brand Voice"));

  if (await fileExists(`${tenantPath}/${SNAPSHOT_PATH}`)) {
    parts.push(await renderCsv(`${tenantPath}/${SNAPSHOT_PATH}`, "Site Snapshot"));
  }

  return parts.filter(Boolean).join("\n\n");
}

async function renderCsv(path: string, label: string): Promise<string> {
  if (!(await fileExists(path))) {
    return "";
  }
  const rows = await readCsvRows(path);
  const preview = rows
    .slice(0, 50)
    .map((row) => JSON.stringify(row))
    .join("\n");
  return `## ${label}\n${preview}`;
}

function localRetrieve(bundle: string, query: string): RetrievalResult {
  const lines = bundle.split(/\r?\n/);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = lines.filter((line) => tokens.some((token) => line.toLowerCase().includes(token)));
  return {
    summary: matches.slice(0, 6).join("\n"),
    citations: matches.slice(0, 3).map((snippet) => ({ source: "local_bundle", snippet })),
  };
}

function slugify(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

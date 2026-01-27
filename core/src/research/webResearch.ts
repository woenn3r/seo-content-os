import { OpenAIClient } from "../clients/openai";

export type ExternalSource = {
  url: string;
  title: string;
  snippet: string;
  why_relevant: string;
  published_at?: string;
  domain?: string;
};

export type ResearchResult = {
  sources: ExternalSource[];
};

export async function runWebResearch(
  query: string,
  model: string
): Promise<{ result: ResearchResult; usage: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
  const client = OpenAIClient.fromEnv();
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["sources"],
    properties: {
      sources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "title", "snippet", "why_relevant"],
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            snippet: { type: "string" },
            why_relevant: { type: "string" },
            published_at: { type: "string" },
            domain: { type: "string" },
          },
        },
      },
    },
  };

  const response = await client.responsesJson<ResearchResult>({
    model,
    instructions:
      "Use web_search to find credible sources. Provide a short snippet and a reason for relevance. Keep snippets brief.",
    prompt: `Find authoritative sources for: ${query}`,
    jsonSchema: { name: "external_sources", schema, strict: true },
    tools: [{ type: "web_search" }],
  });

  return { result: response.data, usage: response.usage };
}

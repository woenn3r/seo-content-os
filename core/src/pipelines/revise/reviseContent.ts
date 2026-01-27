import { OpenAIClient } from "../../clients/openai";

export type RevisionResult = {
  fix_list: Array<{
    rule_id: string;
    message: string;
    fix_instructions?: string;
    evidence?: Record<string, unknown>;
  }>;
  rewrite: string;
  diff: string;
};

export async function reviseContent(input: {
  model: string;
  sourceContent: string;
  instructions?: string;
}): Promise<{ result: RevisionResult; usage: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
  const client = OpenAIClient.fromEnv();
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["fix_list", "rewrite", "diff"],
    properties: {
      fix_list: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule_id", "message"],
          properties: {
            rule_id: { type: "string" },
            message: { type: "string" },
            fix_instructions: { type: "string" },
            evidence: { type: "object" },
          },
        },
      },
      rewrite: { type: "string" },
      diff: { type: "string" },
    },
  };

  const response = await client.responsesJson<RevisionResult>({
    model: input.model,
    instructions:
      input.instructions ||
      "Review the content, list issues, then rewrite it. Provide a unified diff between source and rewrite.",
    prompt: `SOURCE_CONTENT:\n${input.sourceContent}`,
    jsonSchema: { name: "revision_result", schema, strict: true },
  });

  return { result: response.data, usage: response.usage };
}

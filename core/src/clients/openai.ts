type ResponseUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type ResponseContent = {
  type?: string;
  text?: string;
  json?: unknown;
};

type ResponseOutput = {
  type?: string;
  content?: ResponseContent[];
};

type ResponsePayload = {
  output?: ResponseOutput[];
  usage?: ResponseUsage;
};

type JsonSchemaInput = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OpenAIResult<T> = {
  data: T;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
};

export class OpenAIClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  static fromEnv(): OpenAIClient {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY missing.");
    }
    return new OpenAIClient(apiKey);
  }

  async responsesJson<T>(input: {
    model: string;
    instructions?: string;
    prompt: string;
    jsonSchema: JsonSchemaInput;
    tools?: Array<Record<string, unknown>>;
  }): Promise<OpenAIResult<T>> {
    const strict = input.jsonSchema.strict ?? true;
    const schema = strict ? ensureStrictSchema(input.jsonSchema.schema) : input.jsonSchema.schema;
    const payload = {
      model: input.model,
      input: input.prompt,
      instructions: input.instructions,
      text: {
        format: {
          type: "json_schema",
          name: input.jsonSchema.name,
          strict,
          schema,
        },
      },
      tools: input.tools,
    };

    const response = await this.request<ResponsePayload>("/responses", payload);
    const data = extractJson<T>(response);
    return { data, usage: normalizeUsage(response.usage) };
  }

  async responsesText(input: {
    model: string;
    instructions?: string;
    prompt: string;
    tools?: Array<Record<string, unknown>>;
  }): Promise<OpenAIResult<string>> {
    const payload = {
      model: input.model,
      input: input.prompt,
      instructions: input.instructions,
      tools: input.tools,
    };
    const response = await this.request<ResponsePayload>("/responses", payload);
    const text = extractText(response);
    return { data: text, usage: normalizeUsage(response.usage) };
  }

  async createVectorStore(name: string): Promise<string> {
    const response = await this.request<{ id: string }>("/vector_stores", { name });
    return response.id;
  }

  async uploadFile(content: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("purpose", "assistants");
    form.append("file", new Blob([content], { type: "text/plain" }), filename);
    const response = await this.request<{ id: string }>("/files", form, true);
    return response.id;
  }

  async attachFileToVectorStore(vectorStoreId: string, fileId: string): Promise<void> {
    await this.request(`/vector_stores/${vectorStoreId}/files`, { file_id: fileId });
  }

  private async request<T>(path: string, body: any, isMultipart = false): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: isMultipart
        ? { Authorization: `Bearer ${this.apiKey}` }
        : {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
      body: isMultipart ? body : JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
    }
    return (await response.json()) as T;
  }
}

function extractJson<T>(payload: ResponsePayload): T {
  const output = payload.output || [];
  for (const item of output) {
    const content = item.content || [];
    for (const entry of content) {
      if (entry.json) {
        return entry.json as T;
      }
      if (entry.text) {
        try {
          return JSON.parse(entry.text) as T;
        } catch {
          continue;
        }
      }
    }
  }
  throw new Error("OpenAI response JSON missing.");
}

function extractText(payload: ResponsePayload): string {
  const output = payload.output || [];
  for (const item of output) {
    const content = item.content || [];
    for (const entry of content) {
      if (entry.text) {
        return entry.text;
      }
    }
  }
  return "";
}

function normalizeUsage(usage?: ResponseUsage) {
  return {
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    total_tokens: usage?.total_tokens || 0,
  };
}

function ensureStrictSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => ensureStrictSchema(item));
  }

  const copy: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  const isObjectSchema = copy.type === "object" || typeof copy.properties === "object";
  if (isObjectSchema && typeof copy.additionalProperties === "undefined") {
    copy.additionalProperties = false;
  }
  if (copy.properties && typeof copy.properties === "object" && !Array.isArray(copy.properties)) {
    const props = copy.properties as Record<string, unknown>;
    const keys = Object.keys(props);
    const required = new Set(Array.isArray(copy.required) ? (copy.required as string[]) : []);
    for (const key of keys) {
      required.add(key);
      props[key] = ensureStrictSchema(props[key]);
    }
    copy.required = Array.from(required);
    copy.properties = props;
  } else if (isObjectSchema) {
    copy.properties = {};
    copy.required = [];
  }

  if (copy.items) {
    copy.items = ensureStrictSchema(copy.items);
  }
  if (Array.isArray(copy.anyOf)) {
    copy.anyOf = (copy.anyOf as unknown[]).map((entry) => ensureStrictSchema(entry));
  }
  if (Array.isArray(copy.oneOf)) {
    copy.oneOf = (copy.oneOf as unknown[]).map((entry) => ensureStrictSchema(entry));
  }
  if (Array.isArray(copy.allOf)) {
    copy.allOf = (copy.allOf as unknown[]).map((entry) => ensureStrictSchema(entry));
  }

  return copy;
}

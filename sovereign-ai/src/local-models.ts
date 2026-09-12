import { attributionHeaders, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";

export interface LocalModelEndpoint {
  id: string;
  baseUrl: string;
  model: string;
  capabilities: string[];
  contextLength?: number;
  priority?: number;
  available?: boolean;
  apiKey?: string;
}

export interface LocalModelsConfig {
  localModels: LocalModelEndpoint[];
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | WireContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

interface WireContentPart {
  type: "text";
  text: string;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

interface OpenBlock {
  index: number;
  type: "text" | "reasoning" | "tool-call";
  text: string;
  id?: string;
  name?: string;
}

const ROUTE_PREFIX = "sovereign-local-";

export function routeFor(endpoint: LocalModelEndpoint): string {
  return `${ROUTE_PREFIX}${endpoint.id}`;
}

function wireContent(
  blocks: readonly ContentBlock[],
): string | WireContentPart[] {
  const parts: WireContentPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "tool-result":
        {
          const nested = wireContent(block.content);
          if (typeof nested === "string")
            parts.push({ type: "text", text: nested });
          else parts.push(...nested);
        }
        break;
      case "image":
        throw new LlmError(
          "Local OpenAI-compatible models require an attachment-aware image transport, which is not available for this endpoint.",
          "UNSUPPORTED_CONTENT",
        );
      default:
        break;
    }
  }
  return parts.length === 1 && parts[0]?.type === "text"
    ? parts[0].text
    : parts;
}

function wireMessages(options: GenerateOptions): WireMessage[] {
  const messages: WireMessage[] = [];
  if (options.system !== undefined)
    messages.push({ role: "system", content: options.system });
  for (const message of options.messages) {
    if (message.source.kind === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.source.callId,
        content: wireContent(message.content),
      });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = message.content
        .filter(
          (block): block is Extract<ContentBlock, { type: "tool-call" }> =>
            block.type === "tool-call",
        )
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: { name: block.name, arguments: block.arguments },
        }));
      messages.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    messages.push({
      role: message.role,
      content: wireContent(message.content),
    });
  }
  return messages;
}

function mapUsage(
  usage: NonNullable<WireChunk["usage"]>,
): TokenUsage | undefined {
  if (
    usage.prompt_tokens === undefined ||
    usage.completion_tokens === undefined
  )
    return undefined;
  const total = usage.prompt_tokens + usage.completion_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(usage.total_tokens === total ? { totalTokens: total } : {}),
  };
}

function finishReason(reason: string | null | undefined) {
  switch (reason) {
    case "tool_calls":
      return { kind: "tool-calls" as const };
    case "length":
      return { kind: "max-tokens" as const };
    case "stop":
    case null:
    case undefined:
      return { kind: "stop" as const };
    default:
      return {
        kind: "error" as const,
        failure: {
          message: `model stopped: ${reason}`,
          code: reason.toUpperCase(),
        },
      };
  }
}

async function* ssePayloads(response: Response): AsyncGenerator<string> {
  if (response.body === null)
    throw new LlmError(
      "local model response has no body",
      "MALFORMED_RESPONSE",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines)
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      if (result.done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* translate(response: Response): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let text: OpenBlock | undefined;
  let reasoning: OpenBlock | undefined;
  const tools = new Map<number, OpenBlock>();
  const blocks: OpenBlock[] = [];
  let usage: TokenUsage | undefined;
  let finish = finishReason(undefined);
  for await (const payload of ssePayloads(response)) {
    if (payload === "[DONE]") {
      for (const block of blocks) {
        const content: ContentBlock =
          block.type === "text"
            ? { type: "text", text: block.text }
            : block.type === "reasoning"
              ? { type: "reasoning", text: block.text }
              : {
                  type: "tool-call",
                  id: brandString<ToolCallId>(block.id ?? ""),
                  name: block.name ?? "",
                  arguments: block.text,
                };
        yield { type: "block-end", index: block.index, block: content };
      }
      if (usage !== undefined) yield { type: "usage", usage };
      yield { type: "finish", reason: finish };
      return;
    }
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(payload) as WireChunk;
    } catch (error) {
      throw new LlmError(
        `malformed local model SSE payload: ${payload.slice(0, 120)}`,
        "MALFORMED_RESPONSE",
        { cause: error },
      );
    }
    usage = chunk.usage ? mapUsage(chunk.usage) : usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (
        typeof delta?.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
      ) {
        if (reasoning === undefined) {
          reasoning = { index: nextIndex++, type: "reasoning", text: "" };
          blocks.push(reasoning);
          yield {
            type: "block-start",
            index: reasoning.index,
            blockType: "reasoning",
          };
        }
        reasoning.text += delta.reasoning_content;
        yield {
          type: "reasoning-delta",
          index: reasoning.index,
          text: delta.reasoning_content,
        };
      }
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        if (text === undefined) {
          text = { index: nextIndex++, type: "text", text: "" };
          blocks.push(text);
          yield { type: "block-start", index: text.index, blockType: "text" };
        }
        text.text += delta.content;
        yield { type: "text-delta", index: text.index, text: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = tools.get(call.index);
        if (block === undefined) {
          block = { index: nextIndex++, type: "tool-call", text: "" };
          tools.set(call.index, block);
          blocks.push(block);
          yield {
            type: "block-start",
            index: block.index,
            blockType: "tool-call",
          };
        }
        if (call.id) block.id = call.id;
        if (call.function?.name) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: brandString<ToolCallId>(block.id ?? ""),
          ...(block.name === undefined ? {} : { name: block.name }),
          argumentsDelta: fragment,
        };
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null)
        finish = finishReason(choice.finish_reason);
    }
  }
  throw new LlmError(
    "local model SSE stream ended without [DONE]",
    "STREAM_CLOSED",
  );
}

export class LocalOpenAiAdapter extends LlmAdapter {
  constructor(private readonly endpoint: LocalModelEndpoint) {
    super();
  }

  override providerInfo(provider: string) {
    return { id: provider, name: `Sovereign local: ${this.endpoint.id}` };
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      {
        provider,
        id: this.endpoint.model,
        name: this.endpoint.id,
        description: this.endpoint.capabilities.join(", "),
      },
    ]);
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    if (provider !== routeFor(this.endpoint) || model !== this.endpoint.model) {
      return Promise.reject(
        new LlmError(
          `unknown local model route ${provider}/${model}`,
          "UNKNOWN_MODEL",
        ),
      );
    }
    return Promise.resolve({
      provider,
      id: model,
      name: this.endpoint.id,
      description: this.endpoint.capabilities.join(", "),
      ...(this.endpoint.contextLength === undefined
        ? {}
        : { context: { contextWindow: this.endpoint.contextLength } }),
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (
      options.provider !== routeFor(this.endpoint) ||
      options.model !== this.endpoint.model
    ) {
      throw new LlmError(
        `unknown local model route ${options.provider}/${options.model}`,
        "UNKNOWN_MODEL",
      );
    }
    const body = {
      model: this.endpoint.model,
      messages: wireMessages(options),
      stream: true,
      stream_options: { include_usage: true },
      ...(options.tools === undefined
        ? {}
        : {
            tools: options.tools.map((tool) => ({
              type: "function" as const,
              function: tool,
            })),
          }),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.maxTokens === undefined
        ? {}
        : { max_tokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    };
    const headers: Record<string, string> = {
      ...attributionHeaders(),
      "content-type": "application/json",
    };
    if (this.endpoint.apiKey !== undefined)
      headers.authorization = `Bearer ${this.endpoint.apiKey}`;
    const response = await fetch(
      `${this.endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok)
      throw new LlmError(
        `local model request failed with HTTP ${response.status}`,
        "PROVIDER_ERROR",
        { status: response.status },
      );
    yield* translate(response);
  }
}

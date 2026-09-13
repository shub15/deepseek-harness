import type { Context } from "@deepseek-ai/cordis";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, Message } from "@deepseek-ai/dsh-llm";
import type { LocalModelEndpoint } from "../models/local-provider.js";
import { routeFor } from "../models/local-provider.js";

export type ModelCapability =
  | "coding"
  | "reasoning"
  | "document"
  | "vision"
  | "general"
  | "long_context";

export type TaskType = Exclude<ModelCapability, "long_context">;

export interface RoutingDecision {
  readonly taskType: TaskType;
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
}

export interface SovereignRoutingService {
  classify(options: GenerateOptions): TaskType;
  select(taskType: TaskType, override?: string): RoutingDecision;
  listModels(): readonly LocalModelEndpoint[];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sovereignRouting: SovereignRoutingService;
  }

  interface Events {
    "sovereign/routing-decision"(decision: RoutingDecision): void;
  }
}

const CAPABILITY_ALIASES: Record<string, ModelCapability> = {
  coding: "coding",
  reasoning: "reasoning",
  document: "document",
  documents: "document",
  vision: "vision",
  general: "general",
  long_context: "long_context",
  longContext: "long_context",
};

function messageText(message: Message): string {
  return message.content
    .filter((block) => block.type === "text" || block.type === "reasoning")
    .map((block) => block.text)
    .join(" ");
}

function hasImage(options: GenerateOptions): boolean {
  return options.messages.some((message) =>
    message.content.some((block) => block.type === "image"),
  );
}

/** Classify one model request using intentionally small, deterministic keyword rules. */
export function classifyTask(options: GenerateOptions): TaskType {
  if (hasImage(options)) return "vision";
  const text = options.messages.map(messageText).join(" ").toLowerCase();
  if (/\b(image|picture|photo|visual|vision)\b/.test(text)) return "vision";
  if (
    /\b(code|coding|debug|bug|function|class|python|javascript|typescript|compile|stack trace|program)\b/.test(
      text,
    )
  )
    return "coding";
  if (
    /\b(summarize|summary|document|report|pdf|contract|transcript|extract|rewrite|translate)\b/.test(
      text,
    )
  )
    return "document";
  if (
    /\b(calculate|calculation|solve|equation|math|prove|derive|analyze|analyse|reason|why|logic)\b/.test(
      text,
    )
  )
    return "reasoning";
  return "general";
}

function normalizedCapabilities(
  endpoint: LocalModelEndpoint,
): Set<ModelCapability> {
  return new Set(
    endpoint.capabilities.flatMap((capability) => {
      const normalized = CAPABILITY_ALIASES[capability];
      return normalized === undefined ? [] : [normalized];
    }),
  );
}

/** Build the plugin-owned registry and its priority-based local-only selector. */
export function createRoutingService(
  endpoints: readonly LocalModelEndpoint[],
): SovereignRoutingService {
  const models = endpoints.map((endpoint) => ({
    ...endpoint,
    capabilities: [...endpoint.capabilities],
  }));
  const byRoute = new Map(
    models.map((endpoint) => [routeFor(endpoint), endpoint]),
  );

  return {
    classify: classifyTask,
    select(taskType, override) {
      if (override !== undefined) {
        const endpoint =
          byRoute.get(override) ?? models.find((item) => item.id === override);
        if (endpoint !== undefined && endpoint.available !== false) {
          return {
            taskType,
            provider: routeFor(endpoint),
            model: endpoint.model,
            reason: "explicit local model override",
          };
        }
      }
      const candidates = models
        .filter((endpoint) => endpoint.available !== false)
        .filter((endpoint) => {
          const capabilities = normalizedCapabilities(endpoint);
          return capabilities.has(taskType) || capabilities.has("general");
        })
        .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
      const selected = candidates[0];
      if (selected === undefined) {
        throw new LlmError(
          `no available local model supports the ${taskType} capability`,
          "NO_LOCAL_MODEL",
        );
      }
      const exact = normalizedCapabilities(selected).has(taskType);
      return {
        taskType,
        provider: routeFor(selected),
        model: selected.model,
        reason: `${exact ? "capability match" : "general fallback"}; priority ${selected.priority ?? 0}`,
      };
    },
    listModels: () => models,
  };
}

/** Install local-only routing around the existing provider waterfall. */
export function installRouting(
  ctx: Context,
  service: SovereignRoutingService,
): void {
  const handedOff = new WeakSet<object>();
  ctx.provide("sovereignRouting", service);
  ctx.on("llm/stream", (options, next) => {
    if (handedOff.has(options)) {
      handedOff.delete(options);
      return next();
    }
    const explicitLocal = options.provider.startsWith("sovereign-local-")
      ? options.provider
      : undefined;
    const taskType = service.classify(options);
    const decision = service.select(taskType, explicitLocal);
    ctx.emit("sovereign/routing-decision", decision);
    const routed: GenerateOptions = {
      ...options,
      provider: decision.provider,
      model: decision.model,
    };
    handedOff.add(routed);
    return ctx.llm.stream(routed);
  });
}

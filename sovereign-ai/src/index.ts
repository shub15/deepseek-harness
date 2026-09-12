/**
 * Initial Sovereign AI profile layer for SIH 26117.
 *
 * The package contributes local model registration and local-only task routing.
 * @module @sovereign-ai/dsh-plugin
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { LocalOpenAiAdapter } from "./local-models.js";
import type { LocalModelEndpoint } from "./local-models.js";
import { createRoutingService, installRouting } from "./routing.js";
import { createRagService, registerRagTool } from "./rag.js";
import type { RagConfig } from "./rag.js";

export const name = "sovereign-ai";
export const inject = ["commands", "llm", "tools"];

/** Command result subset returned by the initial status command. */
interface CommandResult {
  readonly kind: "success";
  readonly text: string;
}

/** Command invocation metadata accepted by the initial status command. */
interface CommandInvocation {
  readonly rawInput: string;
}

/** Command registration subset provided by `@deepseek-ai/dsh-commands`. */
interface CommandRuntime {
  register(definition: {
    readonly name: string;
    readonly description: string;
    readonly recordInput?: boolean;
    readonly handler: (invocation: CommandInvocation) => CommandResult;
  }): () => void;
}

/** Cordis context after the `commands` service injection is satisfied. */
interface CommandContext extends Context {
  readonly commands: CommandRuntime;
}

/** Deployment metadata reported by `/sovereign-status`. */
export interface Config {
  /** Human-readable plugin version reported by the status command. */
  version?: string;
  /** Deployment mode label reported by the status command. */
  mode?: string;
  /** OpenAI-compatible local model endpoints owned by this deployment. */
  localModels?: LocalModelEndpoint[];
  /** Local knowledge base and local embedding endpoint configuration. */
  rag?: RagConfig;
}

/** Schemastery configuration for the initial Sovereign AI plugin row. */
export const Config: z<Config> = z.object({
  version: z.string().default("0.1.0"),
  mode: z.string().default("development"),
  localModels: z
    .array(
      z.object({
        id: z.string().required(),
        baseUrl: z.string().required(),
        model: z.string().required(),
        capabilities: z.array(z.string()).min(1).required(),
        contextLength: z.number().step(1).min(1),
        priority: z.number().step(1),
        available: z.boolean().default(true),
        apiKey: z.string().role("secret"),
      }),
    )
    .default([]),
  rag: z.object({
    knowledgeBaseDirectory: z.string().required(),
    databasePath: z.string().required(),
    embeddingBaseUrl: z.string().required(),
    embeddingModel: z.string().required(),
    chunkSize: z.number().step(1).min(1),
    chunkOverlap: z.number().step(1).min(0),
    resultLimit: z.number().step(1).min(1),
  }),
});

interface ResolvedConfig {
  readonly version: string;
  readonly mode: string;
  readonly localModels: LocalModelEndpoint[];
  readonly rag?: RagConfig;
}

/** Validate direct `apply()` calls that bypass Loader Schemastery normalization. */
export function resolveConfig(config: Config): ResolvedConfig {
  const version = config.version ?? "0.1.0";
  const mode = config.mode ?? "development";
  if (version.trim().length === 0)
    throw new TypeError("Sovereign AI version must not be empty");
  if (mode.trim().length === 0)
    throw new TypeError("Sovereign AI mode must not be empty");
  return {
    version,
    mode,
    localModels: resolveLocalModels(config.localModels),
    ...(config.rag === undefined ? {} : { rag: config.rag }),
  };
}

function resolveLocalModels(
  models: readonly LocalModelEndpoint[] | undefined,
): LocalModelEndpoint[] {
  const seen = new Set<string>();
  return (models ?? []).map((model) => {
    if (model.id.trim().length === 0)
      throw new TypeError("Sovereign AI local model ids must not be empty");
    if (seen.has(model.id))
      throw new TypeError(
        `Sovereign AI local model id is duplicated: ${model.id}`,
      );
    seen.add(model.id);
    let url: URL;
    try {
      url = new URL(model.baseUrl);
    } catch {
      throw new TypeError(
        `Sovereign AI local model ${model.id} has an invalid baseUrl`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(
        `Sovereign AI local model ${model.id} baseUrl must use http or https`,
      );
    }
    if (model.model.trim().length === 0)
      throw new TypeError(
        `Sovereign AI local model ${model.id} model must not be empty`,
      );
    if (
      model.capabilities.length === 0 ||
      model.capabilities.some((capability) => capability.trim().length === 0)
    ) {
      throw new TypeError(
        `Sovereign AI local model ${model.id} capabilities must not be empty`,
      );
    }
    const allowedCapabilities = new Set([
      "coding",
      "reasoning",
      "document",
      "documents",
      "vision",
      "general",
      "long_context",
      "longContext",
    ]);
    if (
      model.capabilities.some(
        (capability) => !allowedCapabilities.has(capability),
      )
    ) {
      throw new TypeError(
        `Sovereign AI local model ${model.id} has an unsupported capability`,
      );
    }
    if (
      model.contextLength !== undefined &&
      (!Number.isSafeInteger(model.contextLength) || model.contextLength <= 0)
    ) {
      throw new TypeError(
        `Sovereign AI local model ${model.id} contextLength must be a positive integer`,
      );
    }
    if (model.priority !== undefined && !Number.isSafeInteger(model.priority)) {
      throw new TypeError(
        `Sovereign AI local model ${model.id} priority must be an integer`,
      );
    }
    return {
      ...model,
      baseUrl: url.toString().replace(/\/$/, ""),
      capabilities: [...model.capabilities],
      available: model.available ?? true,
    };
  });
}

/** Render the status command response from the normalized plugin config. */
export function renderStatus(config: Config): string {
  const resolved = resolveConfig(config);
  return [
    "Sovereign AI plugin loaded.",
    `Version: ${resolved.version}`,
    `Mode: ${resolved.mode}`,
  ].join("\n");
}

/** Register `/sovereign-status`, proving the out-of-tree plugin row loaded. */
export function apply(ctx: CommandContext, config: Config): void {
  const resolved = resolveConfig(config);
  ctx.commands.register({
    name: "sovereign-status",
    description: "show Sovereign AI plugin load status",
    recordInput: false,
    handler: (): CommandResult => ({
      kind: "success",
      text: renderStatus(resolved),
    }),
  });
  const llm = (
    ctx as CommandContext & {
      llm: {
        registerAdapter: (
          providers: string[],
          adapter: LocalOpenAiAdapter,
        ) => unknown;
      };
    }
  ).llm;
  for (const endpoint of resolved.localModels) {
    llm.registerAdapter(
      [`sovereign-local-${endpoint.id}`],
      new LocalOpenAiAdapter(endpoint),
    );
  }
  installRouting(ctx, createRoutingService(resolved.localModels));
  if (resolved.rag !== undefined) {
    registerRagTool(ctx, createRagService(resolved.rag));
  }
}

export { LocalOpenAiAdapter, routeFor } from "./local-models.js";
export type { LocalModelEndpoint, LocalModelsConfig } from "./local-models.js";
export { createRagService, registerRagTool } from "./rag.js";
export type { RagConfig, RagResult, RagService, RagSource } from "./rag.js";
export {
  classifyTask,
  createRoutingService,
  installRouting,
} from "./routing.js";
export type {
  ModelCapability,
  RoutingDecision,
  SovereignRoutingService,
  TaskType,
} from "./routing.js";

export interface SovereignUiEvent {
  readonly type: string;
  readonly seq?: number;
  readonly time?: number;
  readonly data?: unknown;
}

export interface SovereignUiState {
  readonly sovereignty: "LOCAL" | "BLOCKED" | "UNKNOWN";
  readonly externalCalls: number | undefined;
  readonly blockedCalls: number | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly taskType: string | undefined;
  readonly routingReason: string | undefined;
  readonly trace: readonly string[];
  readonly artifacts: {
    filename: string;
    type: string;
    path: string;
    status: string;
  }[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataOf(
  event: SovereignUiEvent,
): Record<string, unknown> | undefined {
  const data = recordOf(event.data);
  return recordOf(data?.meta) ?? data;
}

function artifactFrom(
  metadata: Record<string, unknown> | undefined,
): SovereignUiState["artifacts"][number] | undefined {
  const path =
    stringValue(metadata?.path) ?? stringValue(metadata?.artifactPath);
  if (path === undefined) return undefined;
  const filename = path.split(/[\\/]/u).at(-1) ?? path;
  const type = filename.includes(".")
    ? (filename.split(".").at(-1)?.toUpperCase() ?? "FILE")
    : "FILE";
  return { filename, type, path, status: "created" };
}

/** Derive the compact panel model from durable session events only. */
export function deriveSovereignUiState(
  events: readonly SovereignUiEvent[],
): SovereignUiState {
  let provider: string | undefined;
  let model: string | undefined;
  let taskType: string | undefined;
  let routingReason: string | undefined;
  let blockedCalls: number | undefined;
  let externalCalls: number | undefined;
  let blocked = false;
  const trace: string[] = [];
  const artifacts: SovereignUiState["artifacts"] = [];

  for (const event of events) {
    const data = recordOf(event.data);
    const metadata = metadataOf(event);
    switch (event.type) {
      case "request/header": {
        const header = recordOf(data?.header);
        const config = recordOf(header?.config);
        provider = stringValue(config?.provider) ?? provider;
        model = stringValue(config?.model) ?? model;
        trace.push(`model ${provider ?? "unknown"}/${model ?? "unknown"}`);
        break;
      }
      case "tool/call":
        trace.push(`tool ${stringValue(data?.name) ?? "unknown"}`);
        break;
      case "tool/result":
        trace.push(
          `tool result ${stringValue(data?.toolCallId) ?? stringValue(recordOf(data?.message)?.source) ?? "complete"}`,
        );
        {
          const artifact = artifactFrom(metadata);
          if (artifact !== undefined) artifacts.push(artifact);
        }
        if (Array.isArray(metadata?.sources))
          trace.push(`RAG sources ${metadata.sources.length}`);
        break;
      case "sovereign/routing-decision":
        taskType = stringValue(data?.taskType) ?? taskType;
        routingReason = stringValue(data?.reason) ?? routingReason;
        provider = stringValue(data?.provider) ?? provider;
        model = stringValue(data?.model) ?? model;
        trace.push(
          `route ${taskType ?? "general"}: ${routingReason ?? "selected"}`,
        );
        break;
      case "sovereign/network-blocked":
        blocked = true;
        blockedCalls = (blockedCalls ?? 0) + 1;
        externalCalls = (externalCalls ?? 0) + 1;
        trace.push("network blocked");
        break;
      default:
        break;
    }
  }

  return {
    sovereignty: blocked
      ? "BLOCKED"
      : events.some(
            (event) =>
              event.type === "request/header" &&
              provider?.startsWith("sovereign-local-") === true,
          )
        ? "LOCAL"
        : "UNKNOWN",
    externalCalls,
    blockedCalls,
    provider,
    model,
    taskType,
    routingReason,
    trace: trace.slice(-40),
    artifacts: artifacts.slice(-20),
  };
}

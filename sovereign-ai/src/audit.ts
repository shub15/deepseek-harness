import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session";
import type { RoutingDecision } from "./routing.js";
import type { SovereigntyMonitor } from "./sovereignty.js";

export interface AuditConfig {
  path?: string;
  maxEntries?: number;
}

export interface AuditEntry {
  readonly timestamp: number;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditTraceService {
  readonly record: (
    entry: Omit<AuditEntry, "timestamp"> & { timestamp?: number },
  ) => void;
  readonly list: () => readonly AuditEntry[];
  readonly clear: () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sovereignAudit: AuditTraceService;
  }
  interface Events {
    "sovereign/routing-decision"(decision: RoutingDecision): void;
    "sovereign/network-blocked"(url: string, kind: string): void;
  }
}

function stringId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(compact);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 16)) {
      if (!/message|content|text|arguments|stream|response/iu.test(key))
        result[key] = compact(item);
    }
    return result;
  }
  return undefined;
}

export function createAuditTrace(config: AuditConfig = {}): AuditTraceService {
  const maxEntries = config.maxEntries ?? 1_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
    throw new TypeError("audit maxEntries must be positive");
  let entries: AuditEntry[] = [];
  let write: Promise<void> = Promise.resolve();
  const record = (
    input: Omit<AuditEntry, "timestamp"> & { timestamp?: number },
  ): void => {
    const entry: AuditEntry = {
      timestamp: input.timestamp ?? Date.now(),
      eventType: input.eventType,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
      metadata: compact(input.metadata) as Readonly<Record<string, unknown>>,
    };
    entries = [...entries, entry].slice(-maxEntries);
    if (config.path !== undefined) {
      write = write.then(async () => {
        await mkdir(dirname(config.path!), { recursive: true });
        await appendFile(config.path!, `${JSON.stringify(entry)}\n`, "utf8");
      });
    }
  };
  return {
    record,
    list: () =>
      entries.map((entry) => ({ ...entry, metadata: { ...entry.metadata } })),
    clear: () => {
      entries = [];
    },
  };
}

function sessionIdOf(session: unknown): string | undefined {
  if (session !== null && typeof session === "object" && "id" in session)
    return stringId(session.id);
  return undefined;
}

export function installAuditTrace(
  ctx: Context,
  audit: AuditTraceService,
  monitor?: SovereigntyMonitor,
): void {
  ctx.provide("sovereignAudit", audit);
  ctx.on("session/event", (session, event) => {
    const sessionId = sessionIdOf(session);
    switch (event.type) {
      case "user/message":
        audit.record({
          timestamp: event.time,
          eventType: "user/request",
          sessionId,
          sequence: Number(event.seq),
          metadata: { source: event.data.source.kind },
        });
        break;
      case "request/header":
        audit.record({
          timestamp: event.time,
          eventType: "model/provider",
          sessionId,
          sequence: Number(event.seq),
          metadata: {
            provider: event.data.header.config.provider,
            model: event.data.header.config.model,
          },
        });
        break;
      case "tool/call":
        audit.record({
          timestamp: event.time,
          eventType: "tool/call",
          sessionId,
          sequence: Number(event.seq),
          metadata: { name: event.data.name, callId: event.data.callId },
        });
        break;
      case "tool/result": {
        const metadata = event.data.meta;
        audit.record({
          timestamp: event.time,
          eventType: "tool/result",
          sessionId,
          sequence: Number(event.seq),
          metadata: {
            toolCallId: event.data.message.source.callId,
            error: event.data.error?.code,
            meta: compact(metadata),
          },
        });
        if (metadata !== undefined && typeof metadata === "object") {
          const value = metadata as Record<string, unknown>;
          if (typeof value.path === "string")
            audit.record({
              timestamp: event.time,
              eventType: "file/created",
              sessionId,
              sequence: Number(event.seq),
              metadata: { path: value.path },
            });
          if (Array.isArray(value.sources))
            audit.record({
              timestamp: event.time,
              eventType: "rag/sources",
              sessionId,
              sequence: Number(event.seq),
              metadata: { sources: compact(value.sources) },
            });
          if (typeof value.artifactPath === "string")
            audit.record({
              timestamp: event.time,
              eventType: "artifact/final",
              sessionId,
              sequence: Number(event.seq),
              metadata: { path: value.artifactPath },
            });
        }
        break;
      }
      default:
        break;
    }
  });
  ctx.on("sovereign/routing-decision", (decision) => {
    audit.record({ eventType: "model/routing", metadata: decision });
  });
  ctx.on("sovereign/network-blocked", (url, kind) => {
    audit.record({ eventType: "network/blocked", metadata: { url, kind } });
  });
  if (monitor !== undefined) {
    const status = monitor.status();
    if (status.blockedCalls > 0)
      audit.record({
        eventType: "network/blocked",
        metadata: { count: status.blockedCalls },
      });
  }
}

import { LlmError } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";

export interface SovereigntyStatus {
  readonly externalCalls: number;
  readonly blockedCalls: number;
  readonly localModelCalls: number;
  readonly cloudCalls: number;
  readonly status: "local-only" | "blocked-external-attempts";
  readonly applicationObserved: true;
  readonly osIsolationEnforced: false;
}

export interface SovereigntyMonitor {
  readonly status: () => SovereigntyStatus;
  readonly allowedEndpoints: readonly string[];
  request(url: string, kind: "local-model" | "embedding"): void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sovereigntyMonitor: SovereigntyMonitor;
  }
}

function localHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local")
  )
    return true;
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 127
  );
}

export function createSovereigntyMonitor(
  endpointUrls: readonly string[],
  onBlocked?: (url: string, kind: "local-model" | "embedding") => void,
): SovereigntyMonitor {
  const allowed = endpointUrls.map((endpoint) => {
    const parsed = new URL(endpoint);
    if (!localHost(parsed.hostname))
      throw new TypeError(`Sovereign endpoint must be local: ${endpoint}`);
    return parsed.origin + parsed.pathname.replace(/\/$/, "");
  });
  let externalCalls = 0;
  let blockedCalls = 0;
  let localModelCalls = 0;
  let cloudCalls = 0;
  return {
    allowedEndpoints: allowed,
    request(url, kind) {
      const parsed = new URL(url);
      const permitted = allowed.some(
        (endpoint) =>
          parsed.href === endpoint || parsed.href.startsWith(`${endpoint}/`),
      );
      if (!permitted) {
        externalCalls += 1;
        blockedCalls += 1;
        cloudCalls += 1;
        onBlocked?.(parsed.href, kind);
        throw new LlmError(
          `Sovereign network policy blocked external endpoint ${parsed.origin}`,
          "SOVEREIGN_NETWORK_BLOCKED",
        );
      }
      if (kind === "local-model") localModelCalls += 1;
    },
    status: () => ({
      externalCalls,
      blockedCalls,
      localModelCalls,
      cloudCalls,
      status: externalCalls === 0 ? "local-only" : "blocked-external-attempts",
      applicationObserved: true,
      osIsolationEnforced: false,
    }),
  };
}

export function installSovereigntyMonitor(
  ctx: Context,
  monitor: SovereigntyMonitor,
): void {
  ctx.provide("sovereigntyMonitor", monitor);
}

export function renderSovereigntyStatus(status: SovereigntyStatus): string {
  return [
    `Sovereignty status: ${status.status}`,
    `Local model calls: ${status.localModelCalls}`,
    `Cloud calls: ${status.cloudCalls}`,
    `Blocked calls: ${status.blockedCalls}`,
    "Counters cover application-observed Sovereign plugin requests only; OS/firewall isolation is not enforced by this monitor.",
  ].join("\n");
}

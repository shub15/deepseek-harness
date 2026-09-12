import { describe, expect, it } from "vitest";
import {
  createSovereigntyMonitor,
  renderSovereigntyStatus,
} from "./sovereignty.ts";

describe("sovereignty monitor", () => {
  it("allows configured local model endpoints", () => {
    const monitor = createSovereigntyMonitor(["http://127.0.0.1:8000/v1"]);

    expect(() =>
      monitor.request(
        "http://127.0.0.1:8000/v1/chat/completions",
        "local-model",
      ),
    ).not.toThrow();
    expect(monitor.status()).toMatchObject({
      externalCalls: 0,
      blockedCalls: 0,
      localModelCalls: 1,
      cloudCalls: 0,
      status: "local-only",
      applicationObserved: true,
      osIsolationEnforced: false,
    });
  });

  it("blocks external endpoint attempts by default", () => {
    const monitor = createSovereigntyMonitor(["http://localhost:8000/v1"]);

    expect(() =>
      monitor.request(
        "https://api.example.com/v1/chat/completions",
        "local-model",
      ),
    ).toThrow("Sovereign network policy blocked");
    expect(monitor.status()).toMatchObject({
      externalCalls: 1,
      blockedCalls: 1,
      localModelCalls: 0,
      cloudCalls: 1,
      status: "blocked-external-attempts",
    });
  });

  it("renders application-only status evidence explicitly", () => {
    const monitor = createSovereigntyMonitor([]);

    expect(renderSovereigntyStatus(monitor.status())).toContain(
      "OS/firewall isolation is not enforced",
    );
  });
});

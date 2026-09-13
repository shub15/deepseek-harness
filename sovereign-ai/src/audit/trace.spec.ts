import { describe, expect, it } from "vitest";
import { createAuditTrace, installAuditTrace } from "./trace.ts";

describe("sovereign audit trace", () => {
  it("replays compact session and plugin events without storing model content", () => {
    const audit = createAuditTrace();
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    const context = {
      provide: () => () => {},
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners[event] = listener;
        return () => {};
      },
      emit: (event: string, ...args: unknown[]) => {
        emitted.push({ event, args });
      },
    };
    installAuditTrace(context as never, audit);

    listeners["session/event"]?.(
      { id: "session-1" },
      {
        type: "user/message",
        seq: 1,
        time: 100,
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "secret prompt" }],
        },
      },
    );
    listeners["sovereign/routing-decision"]?.({
      taskType: "coding",
      provider: "sovereign-local-coder",
      model: "coder",
      reason: "capability match",
    });
    listeners["session/event"]?.(
      { id: "session-1" },
      {
        type: "tool/call",
        seq: 2,
        time: 101,
        data: {
          name: "create_docx",
          callId: "call-1",
          arguments: '{"title":"Report"}',
        },
      },
    );
    listeners["session/event"]?.(
      { id: "session-1" },
      {
        type: "tool/result",
        seq: 3,
        time: 102,
        data: {
          message: { source: { kind: "tool", callId: "call-1" } },
          meta: {
            artifactPath: "output/report.docx",
            sources: [
              { filename: "manual.pdf", page: 2, chunk: 0, score: 0.9 },
            ],
          },
        },
      },
    );
    listeners["sovereign/network-blocked"]?.(
      "https://cloud.example",
      "local-model",
    );

    const entries = audit.list();
    expect(entries.map((entry) => entry.eventType)).toEqual([
      "user/request",
      "model/routing",
      "tool/call",
      "tool/result",
      "rag/sources",
      "artifact/final",
      "network/blocked",
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret prompt");
    expect(
      entries.find((entry) => entry.eventType === "artifact/final")?.metadata,
    ).toMatchObject({ path: "output/report.docx" });
  });
});

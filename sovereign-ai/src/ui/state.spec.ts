import { describe, expect, it } from "vitest";
import { deriveSovereignUiState } from "./state.ts";

describe("Sovereign client state", () => {
  it("derives model, trace, and artifact state from durable events", () => {
    const state = deriveSovereignUiState([
      {
        type: "request/header",
        data: {
          header: {
            config: { provider: "sovereign-local-coder", model: "coder" },
          },
        },
      },
      { type: "tool/call", data: { name: "create_docx" } },
      {
        type: "tool/result",
        data: { meta: { artifactPath: "output/report.docx" } },
      },
    ]);

    expect(state.sovereignty).toBe("LOCAL");
    expect(state.provider).toBe("sovereign-local-coder");
    expect(state.model).toBe("coder");
    expect(state.trace).toEqual([
      "model sovereign-local-coder/coder",
      "tool create_docx",
      "tool result complete",
    ]);
    expect(state.artifacts[0]).toMatchObject({
      filename: "report.docx",
      type: "DOCX",
      status: "created",
    });
  });

  it("marks a blocked network event without scanning transcript text", () => {
    const state = deriveSovereignUiState([
      { type: "assistant/message", data: { content: "network blocked" } },
      {
        type: "sovereign/network-blocked",
        data: { url: "https://cloud.example" },
      },
    ]);
    expect(state.sovereignty).toBe("BLOCKED");
    expect(state.blockedCalls).toBe(1);
    expect(state.externalCalls).toBe(1);
  });
});

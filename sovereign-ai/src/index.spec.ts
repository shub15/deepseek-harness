import { describe, expect, it } from "vitest";
import { apply, renderStatus, resolveConfig } from "./index.ts";
import { routeFor, LocalOpenAiAdapter } from "./index.ts";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { classifyTask, createRoutingService, installRouting } from "./index.ts";

describe("sovereign-ai plugin skeleton", () => {
  it("renders the status command response from config", () => {
    expect(renderStatus({ version: "0.2.0", mode: "demo" })).toBe(
      ["Sovereign AI plugin loaded.", "Version: 0.2.0", "Mode: demo"].join(
        "\n",
      ),
    );
  });

  it("registers the load-proof command", () => {
    let registered:
      | Parameters<Parameters<typeof apply>[0]["commands"]["register"]>[0]
      | undefined;
    const ctx = {
      commands: {
        register(
          definition: Parameters<
            Parameters<typeof apply>[0]["commands"]["register"]
          >[0],
        ) {
          registered = definition;
          return () => {
            registered = undefined;
          };
        },
      },
      llm: { registerAdapter: () => () => {} },
      provide: () => () => {},
      on: () => () => {},
    } as unknown as Parameters<typeof apply>[0];

    apply(ctx, { version: "0.2.0", mode: "demo" });

    expect(registered?.name).toBe("sovereign-status");
    expect(registered?.description).toBe(
      "show Sovereign AI plugin load status",
    );
    expect(registered?.recordInput).toBe(false);
    expect(registered?.handler({ rawInput: "" })).toEqual({
      kind: "success",
      text: [
        "Sovereign AI plugin loaded.",
        "Version: 0.2.0",
        "Mode: demo",
      ].join("\n"),
    });
  });

  it("rejects empty direct-apply config values", () => {
    expect(() => {
      resolveConfig({ version: "  " });
    }).toThrow("Sovereign AI version must not be empty");
    expect(() => {
      resolveConfig({ mode: "" });
    }).toThrow("Sovereign AI mode must not be empty");
  });

  it("validates local endpoint identity and URL facts", () => {
    expect(() =>
      resolveConfig({
        localModels: [
          {
            id: "local",
            baseUrl: "ftp://model",
            model: "model",
            capabilities: ["coding"],
          },
        ],
      }),
    ).toThrow("baseUrl must use http or https");
    expect(() =>
      resolveConfig({
        localModels: [
          {
            id: "local",
            baseUrl: "http://127.0.0.1:8000/v1",
            model: "model",
            capabilities: [],
          },
        ],
      }),
    ).toThrow("capabilities must not be empty");
  });

  it("registers one local route per endpoint", () => {
    const registrations: string[][] = [];
    const ctx = {
      commands: { register: () => () => {} },
      llm: {
        registerAdapter: (providers: string[]) => {
          registrations.push(providers);
          return () => {};
        },
      },
      provide: () => () => {},
      on: () => () => {},
    } as unknown as Parameters<typeof apply>[0];

    apply(ctx, {
      localModels: [
        {
          id: "reasoning",
          baseUrl: "http://127.0.0.1:8000/v1",
          model: "local-reasoning",
          capabilities: ["reasoning"],
        },
        {
          id: "coding",
          baseUrl: "http://127.0.0.1:8001/v1",
          model: "local-coding",
          capabilities: ["coding"],
        },
      ],
    });

    expect(registrations).toEqual([
      ["sovereign-local-reasoning"],
      ["sovereign-local-coding"],
    ]);
  });

  it.each([
    ["fix this Python bug", "coding"],
    ["summarize this report", "document"],
    ["analyze this image", "vision"],
    ["calculate the result", "reasoning"],
  ] as const)("classifies %s as %s", (text, expected) => {
    const options = {
      provider: "remote",
      model: "remote-model",
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text }],
        }),
      ],
    } satisfies GenerateOptions;
    expect(classifyTask(options)).toBe(expected);
  });

  it("selects the highest-priority capable local model and records the reason", () => {
    const service = createRoutingService([
      {
        id: "slow-coder",
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "coder-small",
        capabilities: ["coding"],
        priority: 1,
      },
      {
        id: "fast-coder",
        baseUrl: "http://127.0.0.1:8001/v1",
        model: "coder-large",
        capabilities: ["coding"],
        priority: 10,
      },
      {
        id: "offline-coder",
        baseUrl: "http://127.0.0.1:8002/v1",
        model: "coder-offline",
        capabilities: ["coding"],
        priority: 100,
        available: false,
      },
    ]);

    expect(service.select("coding")).toEqual({
      taskType: "coding",
      provider: "sovereign-local-fast-coder",
      model: "coder-large",
      reason: "capability match; priority 10",
    });
  });

  it("honors an explicit local model override without selecting a remote provider", () => {
    const service = createRoutingService([
      {
        id: "reasoner",
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "reasoner",
        capabilities: ["reasoning"],
      },
      {
        id: "coder",
        baseUrl: "http://127.0.0.1:8001/v1",
        model: "coder",
        capabilities: ["coding"],
      },
    ]);

    expect(service.select("reasoning", "coder")).toEqual({
      taskType: "reasoning",
      provider: "sovereign-local-coder",
      model: "coder",
      reason: "explicit local model override",
    });
  });

  it("routes a remote request through the local llm stream and emits its decision", async () => {
    const endpoint = {
      id: "coder",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "local-coder",
      capabilities: ["coding"],
    };
    const service = createRoutingService([endpoint]);
    let listener:
      | ((
          options: GenerateOptions,
          next: () => AsyncIterable<never>,
        ) => AsyncIterable<never>)
      | undefined;
    const decisions: unknown[] = [];
    const ctx = {
      provide: () => () => {},
      emit: (_event: string, decision: unknown) => decisions.push(decision),
      on: (_event: string, callback: typeof listener) => {
        listener = callback;
        return () => {};
      },
      llm: {
        stream: (options: GenerateOptions) =>
          listener!(options, async function* () {
            yield { type: "finish", reason: { kind: "stop" } } as never;
          }),
      },
    };
    installRouting(ctx as never, service);
    const options = {
      provider: "remote-provider",
      model: "remote-model",
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "fix this Python bug" }],
        }),
      ],
    } satisfies GenerateOptions;

    const routed: unknown[] = [];
    for await (const chunk of listener!(options, async function* () {
      yield { type: "finish", reason: { kind: "stop" } } as never;
    }))
      routed.push(chunk);
    expect(routed).toEqual([{ type: "finish", reason: { kind: "stop" } }]);
    expect(decisions).toEqual([
      {
        taskType: "coding",
        provider: "sovereign-local-coder",
        model: "local-coder",
        reason: "capability match; priority 0",
      },
    ]);
  });

  it("streams OpenAI-compatible text and tool-call deltas without an API key", async () => {
    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      const chunks = [
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks)
              controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    try {
      const endpoint = {
        id: "reasoning",
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "local-reasoning",
        capabilities: ["reasoning"],
      };
      const adapter = new LocalOpenAiAdapter(endpoint);
      const options = {
        provider: routeFor(endpoint),
        model: endpoint.model,
        messages: [
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "hi" }],
          }),
        ],
      } satisfies GenerateOptions;
      const chunks = [];
      for await (const chunk of adapter.stream(options)) chunks.push(chunk);
      expect(requests[0]?.url).toBe(
        "http://127.0.0.1:8000/v1/chat/completions",
      );
      expect(requests[0]?.headers.get("authorization")).toBeNull();
      expect(JSON.parse(await requests[0]!.text()).messages[0].content).toBe(
        "hi",
      );
      expect(
        chunks.some(
          (chunk) => chunk.type === "text-delta" && chunk.text === "hello",
        ),
      ).toBe(true);
      expect(
        chunks.some(
          (chunk) =>
            chunk.type === "tool-call-delta" &&
            chunk.argumentsDelta === '{"q":',
        ),
      ).toBe(true);
      expect(chunks.at(-1)).toEqual({
        type: "finish",
        reason: { kind: "tool-calls" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

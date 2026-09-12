# DeepSeek Harness — Repository Analysis for SIH 26117

> Read-only analysis. No files were modified. Paths are repository-relative.
> Sources: `docs/architecture.md`, `docs/cookbook/extension-cookbook.md`,
> `docs/cookbook/adding-a-tool.md`, `docs/cookbook/adding-an-llm-adapter.md`,
> `docs/subsystems/llm-streaming.md`, `docs/user/develop/basic/publish.md`,
> `packages/README.md`, `packages/client/README.md`,
> `packages/client/AGENTS.md`, `packages/client/ui-slots/README.md`,
> `packages/core/tools/README.md`, `packages/core/system-prompt/README.md`,
> `packages/llm/README.md`, `packages/session/README.md`,
> `packages/web/README.md`.

---

## 1. Extension Points We Should Use

### 1.1 Plugin mount mechanism

Every DSH feature is a Cordis plugin installed through a **bundle** patch layer.
An out-of-tree plugin ships as:

```
my-bundle/
  package.json          # { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
  cordis.patch.yml      # insert rows by name
  index.js / index.ts   # plugin apply() entry
```

Install into a profile:

```sh
dsh plugin --profile <name> add ./my-bundle
```

Reference: [`docs/user/develop/basic/publish.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/docs/user/develop/basic/publish.md)

---

### 1.2 Tool registration — `ctx.tools`

Source: [`packages/core/tools/README.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/core/tools/README.md),
[`docs/cookbook/adding-a-tool.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/docs/cookbook/adding-a-tool.md)

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'ocr_extract',
    description: 'Extract text from an image or PDF.',
    parameters: {
      path: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, v) => [{ type: 'text', text: v }],
    },
    async execute(args, exec) { /* ... */ },
  }))
}
```

Key facts:
- Registration is effect-scoped (HMR-safe; unregisters on plugin teardown).
- Schemas flow into the system-prompt assembly automatically.
- Raw JSON-Schema `ToolDefinition` objects are accepted by `ctx.tools.register()` directly — this is how MCP-sourced tools arrive.
- Pipeline extension points: `tools/pre-execute` (allow/deny/ask),
  `ctx.tools.guard()` (monotonic deny), `tools/execute` (deadline/metrics),
  `tools/post-execute` (transform result), `tools/result` (observe immutable outcome).

---

### 1.3 LLM adapter registration — `ctx.llm`

Source: [`docs/cookbook/adding-an-llm-adapter.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/docs/cookbook/adding-an-llm-adapter.md),
[`docs/subsystems/llm-streaming.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/docs/subsystems/llm-streaming.md)

```ts
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class OllamaAdapter extends LlmAdapter {
  async * stream(options) { /* yield StreamChunk */ }
}

export const inject = ['llm']
export function apply(ctx, config) {
  ctx.llm.registerAdapter(['ollama'], new OllamaAdapter(config))
}
```

`ctx.llm` full surface (`LlmRuntime`):

| Method | Purpose |
|---|---|
| `registerAdapter(providers, adapter)` | Register one adapter for one or more provider route keys |
| `registerConfigurableProviders(entries)` | Declare dormant providers for settings UI |
| `registerModelDiscovery(ns, discover)` | Expose model-discovery interrogation |
| `stream(options)` | Fire a single call through the `llm/stream` waterfall |
| `prepareCall(config, signal?)` | Resolve + bind one adapter generation before logging |
| `listProviders()` / `listModels(provider)` | Advisory catalog |

---

### 1.4 `llm/stream` middleware — waterfall

Source: [`docs/subsystems/llm-streaming.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/docs/subsystems/llm-streaming.md) §`llm/stream`

```ts
ctx.on('llm/stream', async function (options, next) {
  // inspect options, possibly route to a different provider
  const stream = await next()
  return stream  // or yield your own chunks to short-circuit
})
```

Mode: **waterfall** — listeners must call `next()` to delegate; returning without it
short-circuits the call. This is the hook for model routing, replay, retry, or
sovereignty enforcement (block requests to non-local endpoints).

---

### 1.5 Prompt sections — `ctx.systemPrompt`

Source: [`packages/core/system-prompt/README.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/core/system-prompt/README.md)

```ts
export const inject = ['systemPrompt']
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'sovereign:policy',
    order: 500,
    text: 'This deployment operates in sovereign mode. ...',
  })
  ctx.systemPrompt.variable('sovereign_mode', () => 'active')
}
```

Scoped to an agent: register on `agent.ctx` instead of global `ctx`.

---

### 1.6 Session events — `session/event`

Source: [`docs/architecture.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/docs/architecture.md)

```ts
ctx.on('session/event', (session, event) => {
  // event.type: 'turn/start' | 'turn/end' | 'step/start' | 'step/end' |
  //   'assistant/message' | 'assistant/attempt' | 'tool/call' | 'tool/result'
  //   'user/message' | 'request/header' | ...
  if (event.type === 'tool/result') {
    auditLog(session.id, event)
  }
})
```

Agent-lifecycle events (live, not durable):

| Event | Mode | Purpose |
|---|---|---|
| `agent/pre-step` | waterfall | rewrite/reject claimed messages before a step |
| `agent/request` | waterfall | switch provider/model/reasoning per request |
| `llm/stream` | waterfall | wrap every model call |
| `agent/assistant-stream` | emit | live chunk delivery to UI |
| `agent/turn-stopping` | serial | observe/steer at turn end |
| `tools/pre-execute` | waterfall | allow/deny/ask policy |
| `tools/execute` | waterfall | wrap dispatch (timeout, metrics) |
| `tools/post-execute` | waterfall | transform result |
| `tools/result` | emit | observe frozen final outcome |

---

### 1.7 Web UI slots — `ctx.slots`

Source: [`packages/client/AGENTS.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/client/AGENTS.md),
[`packages/client/ui-slots/README.md`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/client/ui-slots/README.md)

```ts
// In the browser-side apply() of a @deepseek-ai/dsh-client-* package:
export const inject = ['slots']
export function apply(ctx) {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({
      name: 'tool.call.toolview',
      // ... slot spec
    }, MyToolViewComponent)
  )
}
```

Key slot names:
- `tool.call.toolview` — per-tool card renderer keyed by wire tool name
- `conversation.chat.node` — Chat business node (`ConversationNodeDefinition`)
- `root` — shell root (shell-owned only)

Adding a Web Client Chat business node:

```ts
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation'

const definition: ConversationNodeDefinition<State, Match> = {
  match(event) { /* ... */ },
  update(state, match) { /* ... */ },
}
ctx.slots.register({ name: 'conversation.chat.node', /* ... */ }, MyRenderer)
```

---

## 2. Existing Packages That Solve Parts of Our Requirements

| Requirement | Existing Package | Location |
|---|---|---|
| **Local open-weight models** (Ollama / llama.cpp) | `dsh-llm-pi-ai` — configure gateway routes; OR new `LlmAdapter` subclass | [`packages/llm/llm-pi-ai/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm-pi-ai) |
| **Model routing** | `llm/stream` waterfall + `agent/request` waterfall | [`packages/llm/llm/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm) |
| **RAG / session search** | `dsh-session-query` (SQLite full-text, semantic filter, corpus) | [`packages/session-query/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/session-query) |
| **Web search/fetch** | `ctx.web` — Exa, Perplexity, DeepSeek, HTTP fetch backends | [`packages/web/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/web) |
| **Audit / agent trace** | `session/event` listener + `ctx.sessionTelemetry` (OpenTelemetry) | [`packages/session/session-telemetry*/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/session) |
| **Artifact generation** | `dsh-tool-fs` `write`/`edit` + `dsh-spill` (tool-result spill) | [`packages/fs/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/fs), [`packages/spill/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/spill) |
| **Background jobs** | `ctx.jobs.start({ kind, label, owner, run })` | [`packages/jobs/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/jobs) |
| **Human approval gate** | `tools/pre-execute` return `{ kind: 'ask' }`, `ctx.approval` | [`packages/interaction/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/interaction) |
| **Sandbox / network isolation** | `ctx.sandbox` backends (bwrap / Landlock / Seatbelt) | [`packages/sandbox/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/sandbox) |
| **MCP tool bridging** | One plugin per server: `ctx.tools.register()` with raw JSON-Schema | [`packages/mcp/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/mcp) |
| **Skills / prompt catalog** | `ctx.skill` — section + tool registration | [`packages/skill/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/skill) |
| **Subagent delegation** | `ctx.subagents` registry + `dsh-tool-subagent` | [`packages/subagent/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/subagent) |
| **Webhook ingest** | `ctx.webhookRuntime` + trusted-rule provider | [`packages/webhook/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/webhook) |
| **Settings UI cards** | `ctx.slots` + `docs/cookbook/adding-a-settings-card.md` | [`packages/client/ui-settings/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/client/ui-settings) |

---

## 3. Exact APIs for Each Registration Surface

### 3.1 Tool registration

```ts
// @deepseek-ai/dsh-tools — packages/core/tools/src/index.ts
ctx.tools.register(defineTool({ name, description, parameters, output, execute }))
// OR raw JSON-Schema (for MCP-like tools):
ctx.tools.register({ name, description, parameters, execute })
```

### 3.2 LLM provider / adapter

```ts
// @deepseek-ai/dsh-llm — packages/llm/llm/src/index.ts
class MyAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'My Provider' } }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> { /* ... */ }
}
ctx.llm.registerAdapter(['my-provider'], new MyAdapter())
ctx.llm.registerConfigurableProviders([{
  provider: 'my-provider',
  displayName: 'My Local Model',
  settingsNs: 'sovereign',
  settingsPath: [],
}])
```

### 3.3 `llm/stream` middleware

```ts
// packages/llm/llm/src/index.ts — @mode waterfall
ctx.on('llm/stream', async function(options, next) {
  // options: GenerateOptions (deep-frozen for loop-built calls)
  return next()  // or yield your own StreamChunks to short-circuit
})
```

### 3.4 Prompt sections

```ts
// @deepseek-ai/dsh-system-prompt — packages/core/system-prompt/src/index.ts
ctx.systemPrompt.section({ name: string, order: number, text: string })
ctx.systemPrompt.variable(name: string, resolver: (ctx) => string | undefined)
// Expert: whole-assembly transform (use sparingly):
ctx.on('system-prompt/assemble', async (assembly, next) => { /* ... */ return next() })
```

### 3.5 Session / event listeners

```ts
// Durable session events:
ctx.on('session/event', (session, event) => { /* ... */ })

// Live agent lifecycle waterfalls (must call next()):
ctx.on('agent/pre-step',      async (input, next) => { return next() })
ctx.on('agent/request',       async (config, next) => { return next() })
ctx.on('llm/stream',          async (options, next) => { return next() })
ctx.on('agent/turn-stopping', (agent) => { /* serial, no next() */ })

// Tool pipeline:
ctx.on('tools/pre-execute',   async (exec, next) => { return next() })
ctx.on('tools/execute',       async (exec, next) => { return next() })
ctx.on('tools/post-execute',  async (exec, next) => { return next() })
ctx.on('tools/result',        (exec) => { /* emit, no next() */ })
```

### 3.6 Web UI slots

```ts
// packages/client/<name>/src/client/apply.ts
export const inject = ['slots']
export function apply(ctx) {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({
      name: 'tool.call.toolview',
      kind: 'keyed',
      select: ({ name }) => name === 'sovereign_audit' ? {} : null,
    }, AuditCardComponent)
  )
}
```

Client `package.json`:
```json
{
  "name": "@sovereign-ai/dsh-client-sovereign",
  "dsh": { "client": { "platform": "web" } },
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" }
}
```

Wire into the web-app bundle overlay (`cordis.patch.yml`):
```yaml
- id: sovereign-client-ui
  name: '@sovereign-ai/dsh-client-sovereign'
```

---

## 4. Feature to Approach Mapping

| Planned Feature | Approach | Rationale |
|---|---|---|
| **Local open-weight models (Ollama, llama.cpp)** | Out-of-tree plugin — `LlmAdapter` subclass, `ctx.llm.registerAdapter(['ollama'], ...)` | Exact extension point; no core change |
| **Model routing (local vs. cloud)** | Out-of-tree plugin — `llm/stream` waterfall + `agent/request` waterfall | Route by session tag, load, or sovereignty policy |
| **Local RAG** | Out-of-tree plugin — tool on `ctx.tools` + prompt section on `ctx.systemPrompt` | Tool calls the local vector store; `inject()` surfaces results |
| **OCR / document tools** | Out-of-tree plugin — `defineTool` on `ctx.tools` | Standard tool; use `exec.signal` for cancellation |
| **Artifact generation** | Existing feature — `dsh-tool-fs` `write`/`edit` + `dsh-spill`; augment with export tool | Already ships; no core modification |
| **Sovereignty / network monitoring** | Out-of-tree plugin — `llm/stream` waterfall + `tools/pre-execute` + `session/event` | Passive observer + optional veto; no loop change |
| **Audit / agent trace** | Out-of-tree plugin — `session/event` listener + optional custom JSONL sink | Fully covered by existing event bus |
| **Small Web UI additions** | Out-of-tree client plugin — `ctx.slots.register` into sidebar/conversation/tool-card slots | Slot system is the exact mechanism; no core modification |
| **Settings card for sovereign config** | Out-of-tree client plugin — `ctx.slots.inject('settings.*', ...)` | Existing settings slot extension point |

> **None of the planned features require core modification.** Every planned capability maps to a documented extension point.

---

## 5. Recommended Package Structure for the Prototype

```
sovereign-ai/                        <- out-of-tree monorepo (separate git repo)
  package.json                       # pnpm workspace root
  pnpm-workspace.yaml
  packages/
    bundle/
      sovereign-base/                # @sovereign-ai/dsh-sovereign-base
        package.json                 #   dsh.bundle -> cordis.patch.yml
        cordis.patch.yml             #   inserts all host-side sovereign plugins
        src/index.ts                 #   (empty bundle entry; plugins are separate rows)
    llm/
      llm-ollama/                    # @sovereign-ai/dsh-llm-ollama
        package.json                 #   @deepseek-ai/dsh-llm as peerDependency
        src/
          adapter.ts                 #   class OllamaAdapter extends LlmAdapter
          index.ts                   #   apply(): ctx.llm.registerAdapter(['ollama'], ...)
    tools/
      tool-ocr/                      # @sovereign-ai/dsh-tool-ocr
        src/index.ts                 #   ctx.tools.register(defineTool({ name: 'ocr_extract' }))
      tool-rag/                      # @sovereign-ai/dsh-tool-rag
        src/index.ts                 #   ctx.tools.register(defineTool({ name: 'rag_query' }))
                                     #   ctx.systemPrompt.section({ name: 'sovereign:rag' })
    monitor/
      sovereignty-monitor/           # @sovereign-ai/dsh-sovereignty-monitor
        src/index.ts                 #   ctx.on('llm/stream', ...)   <- intercept outbound LLM
                                     #   ctx.on('tools/pre-execute') <- block non-sovereign
                                     #   ctx.on('session/event', ...) <- audit log
    client/
      ui-sovereign/                  # @sovereign-ai/dsh-client-ui-sovereign
        package.json                 #   dsh.client.platform = 'web'; exports ./client
        src/
          index.ts                   #   (empty node-half apply)
          client/
            apply.ts                 #   ctx.slots.inject(...) - sovereignty badge, RAG panel
            components/
              SovereigntyBadge.tsx
              RagStatusPanel.tsx
```

### `cordis.patch.yml` for `sovereign-base`

```yaml
# Inserts after dsh-base rows; order matters for service availability.
- insert:
    - id: sovereign-llm-ollama
      name: '@sovereign-ai/dsh-llm-ollama'
      config:
        endpoint: 'http://localhost:11434'
    - id: sovereign-tool-ocr
      name: '@sovereign-ai/dsh-tool-ocr'
    - id: sovereign-tool-rag
      name: '@sovereign-ai/dsh-tool-rag'
      config:
        indexPath: '{{home}}/sovereign-rag-index'
    - id: sovereign-monitor
      name: '@sovereign-ai/dsh-sovereignty-monitor'
      config:
        auditLog: '{{home}}/audit.jsonl'
        allowedProviders: ['ollama']
```

---

## 6. Key API Symbol Table

| Symbol | Package | File |
|---|---|---|
| `ctx.tools.register()` | `@deepseek-ai/dsh-tools` | [`packages/core/tools/src/index.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/core/tools/src/index.ts) |
| `defineTool()` | `@deepseek-ai/dsh-tools` | [`packages/core/tools/src/schema.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/core/tools/src/schema.ts) |
| `ctx.llm.registerAdapter()` | `@deepseek-ai/dsh-llm` | [`packages/llm/llm/src/index.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm/src/index.ts) |
| `LlmAdapter` | `@deepseek-ai/dsh-llm` | [`packages/llm/llm/src/types.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm/src/types.ts) |
| `StreamChunk` | `@deepseek-ai/dsh-llm` | [`packages/llm/llm/src/types.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm/src/types.ts) |
| `GenerateOptions` | `@deepseek-ai/dsh-llm` | [`packages/llm/llm/src/types.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm/src/types.ts) |
| `ctx.systemPrompt.section()` | `@deepseek-ai/dsh-system-prompt` | [`packages/core/system-prompt/src/index.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/core/system-prompt/src/index.ts) |
| `ctx.systemPrompt.variable()` | `@deepseek-ai/dsh-system-prompt` | [`packages/core/system-prompt/src/index.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/core/system-prompt/src/index.ts) |
| `ctx.slots.register()` / `.inject()` | `@deepseek-ai/dsh-client-ui-renderer` | [`packages/client/ui-renderer/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/client/ui-renderer) |
| `ctx.jobs.start()` | `@deepseek-ai/dsh-jobs` | [`packages/jobs/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/jobs) |
| `ctx.sessionTelemetry` | `@deepseek-ai/dsh-session-telemetry` | [`packages/session/session-telemetry/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/session/session-telemetry) |
| `ctx.sessionProjections` | `@deepseek-ai/dsh-session-projection` | [`packages/session/session-projection/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/session/session-projection) |
| `ctx.web` | `@deepseek-ai/dsh-web` | [`packages/web/web/`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/web/web) |
| `expandAssistantStream()` | `@deepseek-ai/dsh-llm` | [`packages/llm/llm/src/stream.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm/src) |
| `createUserMessage()` | `@deepseek-ai/dsh-llm` | [`packages/llm/llm/src/message.ts`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm/src/message.ts) |

---

## 7. Constraints Confirmed

- Do **not** modify [`packages/core/agent-loop`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/core/agent-loop) — the turn flow is a closed extension-point surface.
- Do **not** modify [`packages/llm/llm`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/llm/llm) or any `dsh-llm-*` adapters — new adapters subclass `LlmAdapter` in a new out-of-tree package.
- Do **not** touch [`packages/session/session-persistence*`](file:///e:/Users/Documents/College/Engineering/T.Y.%20Eng/Hackathon/SIH%202026/deepseek-harness/packages/session) — audit/trace uses `session/event` listeners only.
- Do **not** create a second `ctx.agents` factory or parallel agent registry — route through `agent/request` waterfall instead.
- Do **not** create a parallel web server — UI additions use the slot system.
- The correct launch path is `dsh --profile sovereign`, extending `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`.

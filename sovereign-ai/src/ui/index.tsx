import { useMemo, useSyncExternalStore, useState } from "react";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { SessionEventLikeEntry } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { deriveSovereignUiState, type SovereignUiEvent } from "./state.js";

const NS = "sovereign";

const en = {
  status: "Sovereign",
  open: "Open Sovereign status",
  close: "Close Sovereign status",
  sovereignty: "Sovereignty",
  currentModel: "Current model",
  trace: "Agent trace",
  artifacts: "Generated artifacts",
  external: "External calls",
  blocked: "Blocked calls",
  unknown: "UNKNOWN",
  noEvents: "No durable events yet.",
  none: "None",
} as const;

const zh = {
  status: "主权状态",
  open: "打开主权状态",
  close: "关闭主权状态",
  sovereignty: "主权",
  currentModel: "当前模型",
  trace: "代理追踪",
  artifacts: "生成的文件",
  external: "外部调用",
  blocked: "已阻止调用",
  unknown: "未知",
  noEvents: "尚无持久事件。",
  none: "无",
} as const;

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    sovereign: keyof typeof en;
  }
}

export const inject = ["slots", "sessions", "locale"];

type FooterProps = { wide: boolean } & PropsLocale<"sovereign">;

function eventWindow(
  ctx: ClientContext,
  current: SessionId | undefined,
): {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly SessionEventLikeEntry[];
} {
  const source =
    current === undefined
      ? undefined
      : ctx.sessions.binding(current)?.session.eventSource;
  return source === undefined
    ? { subscribe: () => () => {}, getSnapshot: () => [] }
    : {
        subscribe: source.subscribe.bind(source),
        getSnapshot: () => source.getSnapshot().entries,
      };
}

function SovereignPanel({
  ctx,
  wide,
  t,
}: FooterProps & { ctx: ClientContext }) {
  const [open, setOpen] = useState(false);
  const sessions = useSyncExternalStore(
    ctx.sessions.list.subscribe,
    ctx.sessions.list.getSnapshot,
    ctx.sessions.list.getSnapshot,
  );
  const source = useMemo(
    () => eventWindow(ctx, sessions.current),
    [ctx, sessions.current],
  );
  const entries = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
  const events = entries.flatMap((entry): SovereignUiEvent[] =>
    entry.type === "event"
      ? [
          {
            type: entry.event.type,
            seq: Number(entry.event.seq),
            time: entry.event.time,
            data: entry.event.data,
          },
        ]
      : [],
  );
  const state = useMemo(() => deriveSovereignUiState(events), [events]);

  return (
    <div
      style={{
        marginTop: "8px",
        borderTop: "1px solid var(--dsw-alias-border-secondary)",
        paddingTop: "8px",
      }}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-label={t(open ? "close" : "open")}
        style={{
          width: "100%",
          border: 0,
          background: "transparent",
          color: "inherit",
          textAlign: "left",
          cursor: "pointer",
          padding: "6px 0",
          fontWeight: 600,
        }}
      >
        {wide ? `${t("status")} · ${state.sovereignty}` : state.sovereignty}
      </button>
      {open && wide && (
        <div
          style={{
            display: "grid",
            gap: "10px",
            padding: "8px 0",
            fontSize: "12px",
            maxHeight: "360px",
            overflow: "auto",
          }}
        >
          <section>
            <strong>{t("sovereignty")}</strong>
            <div>
              {state.sovereignty} · {t("external")}:{" "}
              {state.externalCalls ?? t("unknown")} · {t("blocked")}:{" "}
              {state.blockedCalls ?? t("unknown")}
            </div>
          </section>
          <section>
            <strong>{t("currentModel")}</strong>
            <div>
              {state.provider ?? t("unknown")} / {state.model ?? t("unknown")}
            </div>
            <div>
              {state.taskType ?? t("unknown")} ·{" "}
              {state.routingReason ?? t("unknown")}
            </div>
          </section>
          <section>
            <strong>{t("trace")}</strong>
            {state.trace.length === 0 ? (
              <div>{t("noEvents")}</div>
            ) : (
              <ol style={{ margin: "4px 0", paddingLeft: "18px" }}>
                {state.trace.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ol>
            )}
          </section>
          <section>
            <strong>{t("artifacts")}</strong>
            {state.artifacts.length === 0 ? (
              <div>{t("none")}</div>
            ) : (
              state.artifacts.map((artifact) => (
                <div key={`${artifact.path}-${artifact.filename}`}>
                  {artifact.filename} · {artifact.type} · {artifact.status}
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { en, zh }),
    "sovereign: dictionaries",
  );
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "sovereign-status",
        locale: NS,
        inject: ({ wide }): FooterProps => ({ wide, t }),
      },
      (props: FooterProps) => <SovereignPanel ctx={ctx} {...props} />,
    ),
  );
}

export { deriveSovereignUiState };

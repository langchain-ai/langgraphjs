/// <reference types="vite/client" />
import { StrictMode } from "react";
import { isBaseMessage, type BaseMessage } from "@langchain/core/messages";
import { Client } from "@langchain/langgraph-sdk";
import { expect, inject, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import * as next from "../../index.js";
import type { Difference, V1Bug } from "./differences.js";

export type Hooks = typeof next;
type Stream = ReturnType<Hooks["useStream"]>;

// main's 1.x hooks, copied out of git by `vitest.config.ts`. A glob import
// keeps the type checker out of them: they type-check on main.
const mainHooks = Object.values(
  import.meta.glob("../../../.parity-v1/index.ts", { eager: true })
)[0] as Hooks;

export const apiUrl = inject("serverUrl");
export const backend = inject("backend");
/** Whether the suite runs on the JS dev server. A `PARITY_SERVER_URL` server counts as an Agent Server. */
export const onJsServer = backend === "js";
/** Whether the server runs the JS test graphs: the JS dev server, or an Agent Server given `PARITY_GRAPHS=js`. */
export const jsGraphs = inject("graphs") === "js";
/** The server's resume point lifetime in seconds, when it was started with a short one (`PARITY_RESUME_TTL`), else 0. */
export const resumeTtl = inject("resumeTtl");
/** A row that tests only the client, run on the JS dev server alone. */
export const itOnJsServer = it.skipIf(!onJsServer);
/** A row that needs the Agent Server: the thread stream, checkpoint joins, async subagents. */
export const itOnAgentServer = it.skipIf(onJsServer);
const realFetch = globalThis.fetch.bind(globalThis);
/** The test's own client, whose requests no side's recording sees. */
export const client = new Client({ apiUrl, callerOptions: { fetch: realFetch } });

/** Waits for the thread's runs to pass `check`. */
export async function runsOf(
  threadId: string,
  check: (runs: Awaited<ReturnType<typeof client.runs.list>>) => boolean
) {
  let runs: Awaited<ReturnType<typeof client.runs.list>> = [];
  await vi.waitFor(
    async () => {
      runs = await client.runs.list(threadId);
      if (!check(runs)) throw new Error(`runs of ${threadId}: ${runs.map((r) => r.status)}`);
    },
    { timeout: 30_000, interval: 100 }
  );
  return runs;
}

/**
 * Waits until the thread's saved state has an interrupt. A 1.x hook that loads
 * the thread before then reads the previous checkpoint and misses the run
 * (`secondHookMissesRunningRun`).
 */
export async function interruptSaved(threadId: string) {
  await vi.waitFor(
    async () => {
      const { tasks } = await client.threads.getState(threadId);
      if (!tasks.some((task) => task.interrupts.length > 0)) throw new Error(`no interrupt saved on ${threadId}`);
    },
    { timeout: 30_000, interval: 50 }
  );
}

/** `stream.hydrate()`, which 1.x has only on its controller. */
export function hydrateOn(side: Side, probe: Probe, threadId?: string): Promise<void> {
  if (side.name === "2.0") return probe.stream.hydrate(threadId);
  const controller = (probe.stream as unknown as Record<symbol, { hydrate(id?: string): Promise<void> }>)[
    side.hooks.STREAM_CONTROLLER
  ];
  return controller.hydrate(threadId);
}

/** A `fetch` that can fail every event stream it has open, as a dropped connection does. */
export function droppableFetch() {
  const drops = new Set<() => void>();
  let opened = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (response.body == null || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    opened += 1;
    const reader = response.body.getReader();
    let dropped = false;
    let drop = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        drop = () => {
          dropped = true;
          drops.delete(drop);
          controller.error(new TypeError("network error"));
          void reader.cancel();
        };
        drops.add(drop);
      },
      async pull(controller) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (dropped) return;
        if (done) {
          drops.delete(drop);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel(reason) {
        drops.delete(drop);
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch, drop: () => [...drops].forEach((drop) => drop()), opened: () => opened };
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** Requests as `METHOD /path`, with ids replaced, for checks on the wire. */
export function wire(requests: RecordedRequest[]) {
  return requests.map(
    (r) => `${r.method} ${r.path.replace(UUID, ":id").split("?")[0]}`
  );
}

export interface Probe {
  readonly stream: Stream;
  readonly extra: unknown;
  readonly trace: Snapshot[];
  readonly calls: [name: string, args: unknown, requestsBefore: number][];
  rerender(props: Partial<ProbeProps>): Promise<void>;
  unmount(): Promise<void>;
  until(check: (stream: Stream) => unknown, what: string): Promise<void>;
}

export interface ProbeProps {
  assistantId: string;
  threadId?: string | null;
  options?: Record<string, unknown>;
  /** Selector hooks to call in the probe. Its result is recorded too. */
  extra?: (stream: Stream, hooks: Hooks) => unknown;
  strict?: boolean;
}

export interface Side {
  readonly name: "1.x" | "2.0";
  readonly hooks: Hooks;
  readonly requests: RecordedRequest[];
  /** The streams this side has open now, as `METHOD /path#n`. */
  readonly open: ReadonlySet<string>;
  mount(props: ProbeProps): Promise<Probe>;
  /** A subagent or subgraph panel: the selector hooks on `target`, in a component of its own. */
  mountPanel(stream: Stream, target: unknown): Promise<Panel>;
}

export interface Panel {
  readonly latest: PanelSnapshot;
  until(check: (panel: PanelSnapshot) => unknown, what: string, timeout?: number): Promise<void>;
  unmount(): Promise<void>;
}

export interface PanelSnapshot {
  messages: MessageSnapshot[];
  toolCalls: { name: string; status: string }[];
  values: string[];
}

const CALLBACKS = ["onThreadId", "onCreated", "onCompleted"] as const;

function makeSide(
  name: Side["name"],
  hooks: Hooks,
  requests: RecordedRequest[],
  open: ReadonlySet<string>
): Side {
  return {
    name,
    hooks,
    requests,
    open,
    async mountPanel(stream, target) {
      let latest: PanelSnapshot = { messages: [], toolCalls: [], values: [] };
      function PanelView() {
        const scoped = target as never;
        const messages = hooks.useMessages(stream as never, scoped);
        const toolCalls = hooks.useToolCalls(stream as never, scoped);
        latest = {
          messages: messages.map(messageSnapshot),
          toolCalls: toolCalls.map((call) => ({ name: call.name, status: call.status })),
          values: Object.keys((hooks.useValues(stream as never, scoped) as object) ?? {}).sort(),
        };
        return null;
      }
      const screen = await render(
        <StrictMode>
          <PanelView />
        </StrictMode>
      );
      return {
        get latest() {
          return latest;
        },
        async until(check, what, timeout = 30_000) {
          await vi.waitFor(
            () => {
              if (!check(latest)) throw new Error(`${name} panel: waiting for ${what}`);
            },
            { timeout, interval: 20 }
          );
        },
        async unmount() {
          await screen.unmount();
        },
      };
    },
    async mount(initial) {
      let props = initial;
      let latest: Stream | undefined;
      let extra: unknown;
      const trace: Snapshot[] = [];
      const calls: Probe["calls"] = [];

      function ProbeView({ current }: { current: ProbeProps }) {
        const options = current.options ?? {};
        const wrapped = Object.fromEntries(
          CALLBACKS.map((callback) => [
            callback,
            (arg: unknown) => {
              calls.push([callback, arg, requests.length]);
              (options[callback] as ((arg: unknown) => void) | undefined)?.(arg);
            },
          ])
        );
        const stream = hooks.useStream({
          apiUrl,
          ...options,
          ...wrapped,
          assistantId: current.assistantId,
          threadId: current.threadId,
        } as never) as Stream;
        const value = current.extra?.(stream, hooks);
        latest = stream;
        extra = value;
        trace.push(snapshot(stream, value));
        return null;
      }

      const view = (current: ProbeProps) =>
        current.strict === false ? (
          <ProbeView current={current} />
        ) : (
          <StrictMode>
            <ProbeView current={current} />
          </StrictMode>
        );
      const screen = await render(view(props));

      return {
        get stream() {
          return latest!;
        },
        get extra() {
          return extra;
        },
        trace,
        calls,
        async rerender(change) {
          props = { ...props, ...change };
          await screen.rerender(view(props));
        },
        async unmount() {
          await screen.unmount();
        },
        async until(check, what) {
          await vi.waitFor(
            () => {
              if (!check(latest!)) throw new Error(`${name}: waiting for ${what}`);
            },
            { timeout: 30_000, interval: 20 }
          );
        },
      };
    },
  };
}

/** Runs `scenario` on one side, with its requests recorded. */
export async function onSide<T>(
  name: Side["name"],
  scenario: (side: Side) => Promise<T>
): Promise<T> {
  const network = recordNetwork();
  try {
    return await scenario(
      makeSide(name, name === "1.x" ? mainHooks : next, network.requests, network.open)
    );
  } finally {
    network.restore();
    await cleanup();
  }
}

/**
 * Runs a scenario on main's 1.x, then on 2.0, each against the same server
 * and with its own requests recorded. A side's streams must all be closed
 * once its components unmount.
 */
export async function onBothSides<T>(
  scenario: (side: Side) => Promise<T>
): Promise<{ v1: T; v2: T }> {
  const results: Partial<Record<Side["name"], T>> = {};
  for (const [name, hooks] of [
    ["1.x", mainHooks],
    ["2.0", next],
  ] as const) {
    const network = recordNetwork();
    try {
      results[name] = await scenario(makeSide(name, hooks, network.requests, network.open));
      await cleanup();
      await expect
        .poll(() => [...network.open], {
          timeout: 5_000,
          message: `${name} left streams open after unmounting`,
        })
        .toEqual([]);
    } finally {
      network.restore();
      await cleanup();
    }
  }
  return { v1: results["1.x"]!, v2: results["2.0"]! };
}

function recordNetwork() {
  const requests: RecordedRequest[] = [];
  const open = new Set<string>();
  const real = globalThis.fetch;
  const origin = new URL(apiUrl).origin;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) return real(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = Object.fromEntries(
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    );
    const request = { method, path: url.pathname + url.search, headers };
    requests.push(request);
    const response = await real(input, init);
    if (
      response.body != null &&
      response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      trackStream(response, `${method} ${url.pathname}#${requests.length}`, open);
    }
    return response;
  };
  return {
    requests,
    open,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

function trackStream(response: Response, key: string, open: Set<string>) {
  const reader = response.body!.getReader();
  open.add(key);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          open.delete(key);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        open.delete(key);
        controller.error(error);
      }
    },
    async cancel(reason) {
      open.delete(key);
      await reader.cancel(reason);
    },
  });
  Object.defineProperty(response, "body", { value: body });
}

export interface Snapshot {
  threadId: string | null;
  isLoading: boolean;
  isThreadLoading: boolean;
  error: string | null;
  messages: MessageSnapshot[];
  valuesKeys: string[];
  toolCalls: unknown[];
  interrupt: unknown;
  interrupts: unknown[];
  subagents: unknown[];
  extra: unknown;
}

interface MessageSnapshot {
  id: string | undefined;
  type: string;
  text: string;
  isClass: boolean;
  shape: "string" | "blocks";
}

function snapshot(stream: Stream, extra: unknown): Snapshot {
  return {
    threadId: stream.threadId ?? null,
    isLoading: Boolean(stream.isLoading),
    isThreadLoading: Boolean(stream.isThreadLoading),
    error: stream.error == null ? null : errorText(stream.error),
    messages: (stream.messages ?? []).map(messageSnapshot),
    valuesKeys: Object.keys((stream.values as object) ?? {}).sort(),
    toolCalls: (stream.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      args: call.args,
      status: call.status,
      output: call.output,
      error: call.error,
    })),
    interrupt: stream.interrupt == null ? null : interruptSnapshot(stream.interrupt),
    interrupts: (stream.interrupts ?? []).map(interruptSnapshot),
    subagents: [...(stream.subagents?.values() ?? [])].map((subagent) => ({
      id: subagent.id,
      name: subagent.name,
      status: subagent.status,
      taskInput: subagent.taskInput,
      output: subagent.output,
      error: subagent.error,
      depth: subagent.depth,
      startedAt: subagent.startedAt instanceof Date,
    })),
    extra: plain(extra),
  };
}

export function messageSnapshot(message: BaseMessage): MessageSnapshot {
  const isClass = isBaseMessage(message);
  return {
    id: message.id,
    type: message.type ?? message.getType(),
    text: isClass
      ? message.text
      : typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    isClass,
    shape: typeof message.content === "string" ? "string" : "blocks",
  };
}

function interruptSnapshot(interrupt: { id?: string; value?: unknown }) {
  return { id: interrupt.id, value: interrupt.value };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function plain(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(plain);
  if (isBaseMessage(value)) return messageSnapshot(value);
  if (value instanceof Date) return "Date";
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, plain(item)])
  );
}

/**
 * What two sides are compared on, once the probe has stopped rendering and
 * calling back: 1.x calls `onCompleted` a macrotask after the run ends.
 */
export async function summary(probe: Probe) {
  await settled(probe);
  const { trace } = probe;
  const last = trace.at(-1)!;
  const { isLoading: _l, isThreadLoading: _t, ...final } = last;
  return normalizeIds({
    final: {
      ...final,
      messages: last.messages.map(({ shape: _shape, ...message }) => message),
    },
    loading: edges(trace.map((s) => s.isLoading)),
    threadLoading: edges(trace.map((s) => s.isThreadLoading)),
    callbacks: probe.calls.map(([name, args]) => [name, plain(args)]),
    streamedInParts: streamedInParts(trace),
  });
}

export type Summary = Awaited<ReturnType<typeof summary>>;

/**
 * Whether each shown message's content is a string or content blocks, which
 * differ by design for streamed AI messages (`streamedContentIsString`).
 */
export function contentShapes(probe: Probe) {
  return probe.trace.at(-1)!.messages.map((message) => message.shape);
}

async function settled(probe: Probe, quietMs = 250) {
  const deadline = Date.now() + 10_000;
  let seen = -1;
  while (Date.now() < deadline) {
    const now = probe.trace.length + probe.calls.length;
    if (now === seen) return;
    seen = now;
    await new Promise((resolve) => setTimeout(resolve, quietMs));
  }
}

/**
 * The sides must match on everything in `summary`, apart from the fields a
 * documented difference covers, which the scenario checks per side.
 */
export function expectSameSummary(
  v1: Summary,
  v2: Summary,
  except?: { fields: string[]; because: (Difference | V1Bug)[] }
) {
  const drop = (s: Summary) => {
    const copy = structuredClone(s) as Record<string, unknown>;
    for (const path of except?.fields ?? []) {
      const keys = path.split(".");
      const last = keys.pop()!;
      let parent: unknown = copy;
      for (const key of keys) parent = (parent as Record<string, unknown>)?.[key];
      if (parent != null) delete (parent as Record<string, unknown>)[last];
    }
    // A dropped field's ids would shift the numbering of every id after it.
    return normalizeIds(copy);
  };
  expect(drop(v2)).toEqual(drop(v1));
}

function edges<T>(values: T[]) {
  return values.filter((value, i) => i === 0 || value !== values[i - 1]);
}

function streamedInParts(trace: Snapshot[]) {
  const final = trace.at(-1)!.messages.filter((m) => m.type === "ai" && m.text.length > 1);
  return final.some((message) =>
    trace.some((s) =>
      s.messages.some(
        (m) =>
          m.id === message.id &&
          m.text.length > 0 &&
          m.text.length < message.text.length &&
          message.text.startsWith(m.text)
      )
    )
  );
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ID_KEY = /^id$|Id$|_id$/;

/** Replaces ids with their order of first appearance, so two sides compare. */
export function normalizeIds<T>(value: T): T {
  const names = new Map<string, string>();
  const name = (id: string) => {
    if (!names.has(id)) names.set(id, `id#${names.size}`);
    return names.get(id)!;
  };
  const walk = (item: unknown, key?: string): unknown => {
    if (typeof item === "string") {
      return key != null && ID_KEY.test(key) ? name(item) : item.replace(UUID, name);
    }
    if (Array.isArray(item)) return item.map((entry) => walk(entry, key));
    if (item != null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([k, entry]) => [k, walk(entry, k)])
      );
    }
    return item;
  };
  return walk(value) as T;
}

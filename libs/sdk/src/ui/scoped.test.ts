import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Client } from "../client.js";
import { ScopeRegistry, holdStream, type ScopeHost } from "./scoped.js";

type JoinEvent = { id?: string; event: string; data: unknown };

const token = (id: string, content: string) => [
  { id, type: "ai", content },
  {},
];
const human = (id: string) => ({ id, type: "human", content: id });

function setup(
  join: (namespaces: string[] | undefined) => JoinEvent[] = () => [],
  host: Partial<ScopeHost> = {}
) {
  const signals: AbortSignal[] = [];
  const client = {
    runs: {
      joinStream: vi.fn(
        (
          _threadId: string,
          _runId: string,
          options: { signal: AbortSignal; streamNamespaces?: string[] }
        ) => {
          signals.push(options.signal);
          return (async function* events() {
            yield* join(options.streamNamespaces);
            await new Promise((resolve) =>
              options.signal.addEventListener("abort", resolve)
            );
          })();
        }
      ),
    },
    threads: { getHistory: vi.fn().mockResolvedValue([]) },
  };
  const onEvent = vi.fn();
  const registry: ScopeRegistry = new ScopeRegistry({
    client: () => client as unknown as Client,
    threadId: () => "t1",
    messagesKey: () => "messages",
    reconnectOptions: () => ({}),
    canFilter: async () => true,
    rootMessageIds: () => new Set(),
    finished: () => false,
    onEvent,
    ...host,
  });
  registries.push(registry);
  const joined = (call: number) =>
    (client.runs.joinStream as Mock).mock.calls[call][2];
  return { registry, client, signals, onEvent, joined };
}

const ids = (messages: { id?: string }[]) => messages.map((m) => m.id);

const registries: ScopeRegistry[] = [];

describe("ScopeRegistry", () => {
  afterEach(() => {
    // A failed test can't leave a join holding the page's stream budget.
    registries.splice(0).forEach((registry) => registry.dispose());
    vi.restoreAllMocks();
  });

  it("two panels opening mid-run share one join from the run's start", async () => {
    const { registry, client, joined } = setup(() => [
      { id: "1", event: "messages|tools:a", data: token("a1", "from a") },
      { id: "2", event: "messages|tools:b", data: token("b1", "from b") },
    ]);
    registry.setRun("run-1");

    const a = registry.acquire(["tools:a"]);
    const b = registry.acquire(["tools:b"]);

    await vi.waitFor(() => expect(ids(b.getSnapshot().messages)).toEqual(["b1"]));
    expect(ids(a.getSnapshot().messages)).toEqual(["a1"]);
    expect(client.runs.joinStream).toHaveBeenCalledOnce();
    expect(joined(0)).toMatchObject({
      lastEventId: "-1",
      streamNamespaces: ["tools:a", "tools:b"],
    });
    registry.dispose();
  });

  it("a panel opened later gets its subagent from the start, and the open one shows each message once", async () => {
    const events: JoinEvent[] = [
      { id: "1", event: "messages|tools:a", data: token("a1", "Hel") },
      { id: "2", event: "messages|tools:a", data: token("a1", "lo") },
    ];
    const { registry, client } = setup(() => events);
    registry.setRun("run-1");
    const a = registry.acquire(["tools:a"]);
    await vi.waitFor(() =>
      expect(a.getSnapshot().messages[0]?.content).toBe("Hello")
    );

    events.push({ id: "3", event: "messages|tools:b", data: token("b1", "b") });
    const b = registry.acquire(["tools:b"]);

    await vi.waitFor(() => expect(ids(b.getSnapshot().messages)).toEqual(["b1"]));
    expect(client.runs.joinStream).toHaveBeenCalledTimes(2);
    expect(a.getSnapshot().messages.map((m) => m.content)).toEqual(["Hello"]);
    registry.dispose();
  });

  it("a panel closing while its join reconnects reopens without it", async () => {
    const { registry, client, signals, joined } = setup();
    registry.setRun("run-1");
    registry.acquire(["tools:a"]);
    const b = registry.acquire(["tools:b"]);
    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledOnce());

    b.release();

    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(joined(1).streamNamespaces).toEqual(["tools:a"]);
    registry.dispose();
  });

  it("the last release closes the join, and a held scope opens none for a run without subgraphs", async () => {
    const { registry, client, signals } = setup();
    registry.setRun("run-1");
    const a = registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledOnce());

    a.release();
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));

    registry.acquire(["tools:a"]);
    registry.setRun("run-2", { subgraphs: false });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.runs.joinStream).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it("without a server filter, a panel takes only its own subagent's events", async () => {
    const { registry, joined, onEvent } = setup(
      () => [
        { id: "1", event: "messages", data: token("root", "chat") },
        { id: "2", event: "messages|tools:a", data: token("a1", "mine") },
        { id: "3", event: "messages|tools:a|tools:b", data: token("b1", "nested") },
        {
          id: "4",
          event: "messages",
          data: [{ id: "old", type: "ai", content: "old core" }, { langgraph_checkpoint_ns: "tools:a|model:x" }],
        },
      ],
      { canFilter: async () => false }
    );
    registry.setRun("run-1");
    const a = registry.acquire(["tools:a"]);

    await vi.waitFor(() =>
      expect(ids(a.getSnapshot().messages)).toEqual(["a1", "old"])
    );
    expect(joined(0).streamNamespaces).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("hands the panels' events to the channels once, when the run's stream is filtered", async () => {
    const { registry, client, onEvent } = setup(() => [
      { id: "1", event: "metadata", data: { run_id: "run-1" } },
      { id: "2", event: "custom|tools:a", data: { step: 1 } },
      { id: "3", event: "lifecycle|tools:a|tools:b", data: { event: "started" } },
      { id: "4", event: "end", data: { status: "success" } },
    ]);
    registry.setRun("run-1", { filtered: true });
    const first = registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onEvent.mock.calls).toEqual([["custom|tools:a", { step: 1 }]]);
    registry.dispose();
  });

  it("hands the channels nothing when the run's own stream carries the panels' events", async () => {
    const { registry, client, onEvent } = setup(() => [
      { id: "1", event: "custom|tools:a", data: { step: 1 } },
    ]);
    registry.setRun("run-1", { filtered: false });
    registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onEvent).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("a restart puts each panel back to its last values, and a replayed restart doesn't", async () => {
    const events: JoinEvent[] = [
      { id: "1", event: "metadata", data: { attempt: 1 } },
      { id: "2", event: "values|tools:a", data: { messages: [human("h1")] } },
      { id: "3", event: "messages|tools:a", data: token("cut", "Hel") },
      { id: "4", event: "metadata", data: { attempt: 2 } },
      { id: "5", event: "messages|tools:a", data: token("again", "Hello") },
    ];
    const { registry, client } = setup(() => events);
    registry.setRun("run-1");
    const a = registry.acquire(["tools:a"]);
    await vi.waitFor(() =>
      expect(ids(a.getSnapshot().messages)).toEqual(["h1", "again"])
    );

    registry.acquire(["tools:b"]);
    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ids(a.getSnapshot().messages)).toEqual(["h1", "again"]);
    registry.dispose();
  });

  it("a panel opened after another panel saw a restart gets only the new attempt", async () => {
    const events: JoinEvent[] = [
      { id: "1", event: "metadata", data: { attempt: 1 } },
      { id: "2", event: "values|tools:b", data: { messages: [human("hb")] } },
      { id: "3", event: "messages|tools:b", data: token("cut-b", "Hel") },
      { id: "4", event: "metadata", data: { attempt: 2 } },
      { id: "5", event: "messages|tools:b", data: token("again-b", "Hello") },
    ];
    const { registry, client } = setup(() => events);
    registry.setRun("run-1");
    registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const b = registry.acquire(["tools:b"]);

    await vi.waitFor(() =>
      expect(ids(b.getSnapshot().messages)).toEqual(["hb", "again-b"])
    );
    registry.dispose();
  });

  it("a run's end leaves a join that is still replaying it to finish", async () => {
    let replay!: () => void;
    const rest = new Promise<void>((resolve) => {
      replay = resolve;
    });
    const { registry, client, signals } = setup();
    (client.runs.joinStream as Mock).mockImplementation(
      (_threadId: string, _runId: string, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return (async function* events() {
          yield { id: "1", event: "messages|tools:a", data: token("a1", "a") };
          await rest;
          yield { id: "2", event: "messages|tools:a", data: token("a2", "b") };
        })();
      }
    );
    registry.setRun("run-1");
    const a = registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(ids(a.getSnapshot().messages)).toEqual(["a1"]));

    registry.endRun("run-1");
    registry.acquire(["tools:b"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    replay();

    await vi.waitFor(() =>
      expect(ids(a.getSnapshot().messages)).toEqual(["a1", "a2"])
    );
    expect(signals[0].aborted).toBe(false);
    expect(client.runs.joinStream).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it("a join waiting for a free stream still opens after the run ends", async () => {
    const held = [holdStream(), holdStream(), holdStream(), holdStream()];
    const { registry, client } = setup();
    try {
      registry.setRun("run-1");
      registry.acquire(["tools:a"]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      registry.endRun("run-1");
      held[0]();

      await vi.waitFor(() =>
        expect(client.runs.joinStream).toHaveBeenCalledOnce()
      );
    } finally {
      registry.dispose();
      held.forEach((release) => release());
    }
  });

  it("a scope its run's join can't fill is read from history when the run ends", async () => {
    const { registry, client } = setup();
    (client.threads.getHistory as Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ values: { messages: [human("done")] } }]);
    registry.setRun("run-1", { subgraphs: false });
    const a = registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(client.threads.getHistory).toHaveBeenCalledOnce());

    registry.endRun("run-1");

    await vi.waitFor(() => expect(ids(a.getSnapshot().messages)).toEqual(["done"]));
    expect(client.runs.joinStream).not.toHaveBeenCalled();
  });

  it("the same run joined again after its end streams new panels", async () => {
    const { registry, client } = setup();
    registry.setRun("run-1");
    registry.endRun("run-1");

    registry.setRun("run-1");
    registry.acquire(["tools:b"]);

    await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalledOnce());
    registry.dispose();
  });

  it("a run without subgraphs reads its panels again when it ends", async () => {
    const { registry, client } = setup();
    (client.threads.getHistory as Mock)
      .mockResolvedValueOnce([{ values: { messages: [human("early")] } }])
      .mockResolvedValueOnce([
        { values: { messages: [human("early"), human("final")] } },
      ]);
    registry.setRun("run-1", { subgraphs: false });
    const a = registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(ids(a.getSnapshot().messages)).toEqual(["early"]));

    registry.endRun("run-1");

    await vi.waitFor(() =>
      expect(ids(a.getSnapshot().messages)).toEqual(["early", "final"])
    );
  });

  it("a join that sends the run's first metadata again keeps the panels", async () => {
    const { registry } = setup(() => [
      { id: "1", event: "metadata", data: { attempt: 1 } },
      { id: "2", event: "values|tools:a", data: { messages: [human("h1")] } },
      { id: "3", event: "messages|tools:a", data: token("a3", "kept") },
      { id: "1", event: "metadata", data: { attempt: 1 } },
      { id: "4", event: "messages|tools:a", data: token("a4", "next") },
    ]);
    registry.setRun("run-1");
    const a = registry.acquire(["tools:a"]);

    await vi.waitFor(() =>
      expect(ids(a.getSnapshot().messages)).toEqual(["h1", "a3", "a4"])
    );
    registry.dispose();
  });

  it("a run whose id arrives after dispose opens no join", async () => {
    const { registry, client } = setup();
    registry.acquire(["tools:a"]);

    registry.dispose();
    registry.setRun("run-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.runs.joinStream).not.toHaveBeenCalled();
  });

  it("a panel join waits while four streams are open and opens when one closes", async () => {
    const held = [holdStream(), holdStream(), holdStream(), holdStream()];
    const { registry, client } = setup();
    try {
      registry.setRun("run-1");
      registry.acquire(["tools:a"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.runs.joinStream).not.toHaveBeenCalled();

      held[0]();
      await vi.waitFor(() =>
        expect(client.runs.joinStream).toHaveBeenCalledOnce()
      );
    } finally {
      registry.dispose();
      held.forEach((release) => release());
    }
  });

  it("a finished panel after a reload reads its namespace once, without the parent's messages", async () => {
    const { registry, client } = setup(undefined, {
      rootMessageIds: () => new Set(["parent"]),
    });
    (client.threads.getHistory as Mock).mockResolvedValue([
      { values: { messages: [human("parent"), human("own")], files: {} } },
    ]);

    const a = registry.acquire(["tools:a"]);
    registry.acquire(["tools:a"]);

    await vi.waitFor(() => expect(ids(a.getSnapshot().messages)).toEqual(["own"]));
    expect(a.getSnapshot().values).toMatchObject({ files: {} });
    expect(client.threads.getHistory).toHaveBeenCalledExactlyOnceWith("t1", {
      checkpoint: { checkpoint_ns: "tools:a" },
      limit: 1,
    });
    expect(client.runs.joinStream).not.toHaveBeenCalled();
  });

  it("a 400 stops panel reads for the thread", async () => {
    const { registry, client } = setup();
    (client.threads.getHistory as Mock).mockRejectedValue(
      Object.assign(new Error("Subgraph tools not found"), { status: 400 })
    );

    registry.acquire(["tools:a"]);
    await vi.waitFor(() => expect(client.threads.getHistory).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    registry.acquire(["tools:b"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.threads.getHistory).toHaveBeenCalledOnce();
  });

  it("notifies a scope's listeners once per macrotask", async () => {
    const { registry } = setup(() => [
      { id: "1", event: "messages|tools:a", data: token("a1", "a") },
      { id: "2", event: "messages|tools:a", data: token("a1", "b") },
    ]);
    registry.setRun("run-1");
    const a = registry.acquire(["tools:a"]);
    const listener = vi.fn();
    a.subscribe(listener);

    await vi.waitFor(() => expect(a.getSnapshot().messages[0]?.content).toBe("ab"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).toHaveBeenCalledOnce();
    registry.dispose();
  });
});

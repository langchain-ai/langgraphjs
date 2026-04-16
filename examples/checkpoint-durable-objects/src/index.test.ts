import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const PORT = 8787;
const WS_BASE = `ws://localhost:${PORT}`;
const HTTP_BASE = `http://localhost:${PORT}`;
const CWD = resolve(import.meta.dirname, "..");
const RUN = randomUUID().slice(0, 8);

let wrangler: ChildProcess;

// --- Helpers ---

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(HTTP_BASE);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start in time");
}

function connect(name: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/thread/${RUN}-${name}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function send(ws: WebSocket, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws response timeout")), 10_000);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(raw.toString()));
    });
    ws.send(JSON.stringify(data));
  });
}

// --- Setup ---

beforeAll(async () => {
  wrangler = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(PORT)], {
    cwd: CWD,
    stdio: ["ignore", "pipe", "pipe"],
  });
  wrangler.stderr?.on("data", (d: Buffer) => {
    const l = d.toString().trim();
    if (l) process.stderr.write(`  [wrangler] ${l}\n`);
  });
  await waitForServer();
}, 45_000);

afterAll(() => wrangler?.kill("SIGTERM"));

// --- Tests ---

describe("chat", () => {
  it("sends a message and gets echo response", async () => {
    const ws = await connect("chat-basic");
    const r = await send(ws, { type: "message", content: "hello" });

    expect(r.type).toBe("response");
    expect(r.messageCount).toBe(2);
    expect(r.userMessage).toMatchObject({ role: "user", content: "hello" });
    expect(r.assistantMessage).toMatchObject({ role: "assistant", content: "Echo: hello" });
    expect(r.checkpointId).toBeDefined();

    ws.close();
  });

  it("accumulates messages across turns", async () => {
    const ws = await connect("chat-accum");

    const r1 = await send(ws, { type: "message", content: "one" });
    expect(r1.messageCount).toBe(2);

    const r2 = await send(ws, { type: "message", content: "two" });
    expect(r2.messageCount).toBe(4);

    const r3 = await send(ws, { type: "message", content: "three" });
    expect(r3.messageCount).toBe(6);

    ws.close();
  });

  it("retrieves messages", async () => {
    const ws = await connect("chat-get");
    await send(ws, { type: "message", content: "a" });
    await send(ws, { type: "message", content: "b" });

    const r = await send(ws, { type: "get_messages" });
    expect(r.type).toBe("messages");
    expect(r.messages).toHaveLength(4);

    ws.close();
  });

  it("retrieves history", async () => {
    const ws = await connect("chat-hist");
    await send(ws, { type: "message", content: "x" });
    await send(ws, { type: "message", content: "y" });

    const r = await send(ws, { type: "get_history" });
    expect(r.type).toBe("history");
    const history = r.history as Array<{ messageCount: number }>;
    expect(history).toHaveLength(2);
    expect(history[0].messageCount).toBe(4);
    expect(history[1].messageCount).toBe(2);

    ws.close();
  });

  it("persists across reconnects", async () => {
    const name = "chat-reconnect";
    const ws1 = await connect(name);
    await send(ws1, { type: "message", content: "before" });
    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    const ws2 = await connect(name);
    const r = await send(ws2, { type: "get_messages" });
    expect(r.messages).toHaveLength(2);

    const r2 = await send(ws2, { type: "message", content: "after" });
    expect(r2.messageCount).toBe(4);
    ws2.close();
  });
});

describe("fork", () => {
  it("reads state at a specific checkpoint", async () => {
    const ws = await connect("fork-read");

    const r1 = await send(ws, { type: "message", content: "first" });
    const cp1 = r1.checkpointId as string;

    await send(ws, { type: "message", content: "second" });
    await send(ws, { type: "message", content: "third" });

    const forked = await send(ws, { type: "fork", checkpointId: cp1 });
    expect(forked.type).toBe("forked");
    expect(forked.messageCount).toBe(2);
    const msgs = forked.messages as Array<{ content: string }>;
    expect(msgs[0].content).toBe("first");
    expect(msgs[1].content).toBe("Echo: first");

    ws.close();
  });

  it("continues both branches independently after a fork", async () => {
    const ws = await connect("fork-branch");

    // Build common history: msg1 → msg2
    const r1 = await send(ws, { type: "message", content: "msg1" });
    const cp1 = r1.checkpointId as string;

    const r2 = await send(ws, { type: "message", content: "msg2" });
    const cp2 = r2.checkpointId as string;
    expect(r2.messageCount).toBe(4);

    // Continue branch A from cp2 (the latest)
    const branchA = await send(ws, { type: "message", content: "branch-A-msg" });
    const cpA = branchA.checkpointId as string;
    expect(branchA.messageCount).toBe(6);

    // Continue branch B from cp1 (fork point — cp1 already has child cp2)
    const branchB = await send(ws, {
      type: "message",
      content: "branch-B-msg",
      parentCheckpointId: cp1,
    });
    const cpB = branchB.checkpointId as string;
    // Branch B: msg1 (2 msgs) + branch-B-msg (2 msgs) = 4
    expect(branchB.messageCount).toBe(4);

    // Verify branch A state
    const forkA = await send(ws, { type: "fork", checkpointId: cpA });
    const msgsA = forkA.messages as Array<{ content: string }>;
    expect(msgsA).toHaveLength(6);
    expect(msgsA.map((m) => m.content)).toEqual([
      "msg1", "Echo: msg1",
      "msg2", "Echo: msg2",
      "branch-A-msg", "Echo: branch-A-msg",
    ]);

    // Verify branch B state
    const forkB = await send(ws, { type: "fork", checkpointId: cpB });
    const msgsB = forkB.messages as Array<{ content: string }>;
    expect(msgsB).toHaveLength(4);
    expect(msgsB.map((m) => m.content)).toEqual([
      "msg1", "Echo: msg1",
      "branch-B-msg", "Echo: branch-B-msg",
    ]);

    // Continue branch B further
    const branchB2 = await send(ws, {
      type: "message",
      content: "branch-B-msg2",
      parentCheckpointId: cpB,
    });
    expect(branchB2.messageCount).toBe(6);

    // Branch A should be unaffected
    const forkA2 = await send(ws, { type: "fork", checkpointId: cpA });
    expect((forkA2.messages as unknown[]).length).toBe(6);

    ws.close();
  });

  it("three-way fork from the same checkpoint", async () => {
    const ws = await connect("fork-three");

    const r1 = await send(ws, { type: "message", content: "root" });
    const cpRoot = r1.checkpointId as string;

    // Three branches from the same point
    const a = await send(ws, { type: "message", content: "A", parentCheckpointId: cpRoot });
    const b = await send(ws, { type: "message", content: "B", parentCheckpointId: cpRoot });
    const c = await send(ws, { type: "message", content: "C", parentCheckpointId: cpRoot });

    // Each branch has root (2) + own message (2) = 4
    expect(a.messageCount).toBe(4);
    expect(b.messageCount).toBe(4);
    expect(c.messageCount).toBe(4);

    // Verify each branch has the right content
    const fA = await send(ws, { type: "fork", checkpointId: a.checkpointId as string });
    const fB = await send(ws, { type: "fork", checkpointId: b.checkpointId as string });
    const fC = await send(ws, { type: "fork", checkpointId: c.checkpointId as string });

    expect((fA.messages as Array<{ content: string }>)[2].content).toBe("A");
    expect((fB.messages as Array<{ content: string }>)[2].content).toBe("B");
    expect((fC.messages as Array<{ content: string }>)[2].content).toBe("C");

    ws.close();
  });

  it("returns error for nonexistent checkpoint", async () => {
    const ws = await connect("fork-missing");
    const r = await send(ws, { type: "fork", checkpointId: "nonexistent-id" });
    expect(r.type).toBe("error");
    expect(r.error).toBe("checkpoint not found");
    ws.close();
  });

  it("returns error when checkpointId is missing", async () => {
    const ws = await connect("fork-no-id");
    const r = await send(ws, { type: "fork" });
    expect(r.type).toBe("error");
    expect(r.error).toBe("missing checkpointId");
    ws.close();
  });

  it("returns error when parentCheckpointId does not exist", async () => {
    const ws = await connect("fork-bad-parent");
    const r = await send(ws, {
      type: "message",
      content: "hello",
      parentCheckpointId: "nonexistent",
    });
    expect(r.type).toBe("error");
    expect(r.error).toBe("parent checkpoint not found");
    ws.close();
  });
});

describe("errors", () => {
  it("rejects invalid JSON", async () => {
    const ws = await connect("err-json");
    const r: Record<string, unknown> = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 5_000);
      ws.once("message", (raw) => {
        clearTimeout(t);
        resolve(JSON.parse(raw.toString()));
      });
      ws.send("not json{{{");
    });
    expect(r.type).toBe("error");
    ws.close();
  });

  it("rejects unknown message type", async () => {
    const ws = await connect("err-type");
    const r = await send(ws, { type: "bogus" });
    expect(r.type).toBe("error");
    expect(r.error).toContain("unknown type");
    ws.close();
  });
});

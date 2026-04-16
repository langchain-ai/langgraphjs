/**
 * Cloudflare Worker + Durable Object: WebSocket chat with checkpointed state.
 *
 * GET /                        — Chat UI
 * ws://localhost:8787/thread/:threadId — WebSocket API
 *
 * Messages (send JSON):
 *   { "type": "message", "content": "hello" }                              — append to latest
 *   { "type": "message", "content": "hello", "parentCheckpointId": "..." } — append to specific checkpoint (branch)
 *   { "type": "fork", "checkpointId": "..." }                              — read state at a checkpoint
 *   { "type": "get_messages" }
 *   { "type": "get_history" }
 *
 * Set OPENAI_BASE_URL env var to point to an eliza server (default: http://localhost:8080)
 */

import { DurableObject } from "cloudflare:workers";
import {
  DurableObjectSqliteSaver,
  DurableObjectBackend,
} from "@langchain/langgraph-checkpoint-durable-objects";
import { uuid6 } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(
  id: string,
  messages: unknown[],
  step: number
): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: { messages },
    channel_versions: { messages: step + 1 },
    versions_seen: { agent: { messages: step } },
  };
}

function makeMetadata(
  step: number,
  parentId?: string
): CheckpointMetadata {
  return {
    source: "loop",
    step,
    parents: parentId ? { "": parentId } : {},
  };
}

function tupleMessages(tuple: CheckpointTuple | undefined): unknown[] {
  return (tuple?.checkpoint.channel_values.messages as unknown[]) ?? [];
}

function tupleCheckpointId(tuple: CheckpointTuple | undefined): string | undefined {
  return tuple?.config.configurable?.checkpoint_id as string | undefined;
}

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class ChatDO extends DurableObject<Env> {
  private saver: DurableObjectSqliteSaver;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.saver = new DurableObjectSqliteSaver(
      new DurableObjectBackend(ctx.storage),
      { listChannels: new Set(["messages"]) }
    );
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const threadId = url.pathname.split("/").filter(Boolean).pop()!;

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [threadId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const threadId = this.ctx.getTags(ws)[0];
    if (!threadId) return this.send(ws, "error", { error: "no thread ID" });

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, "error", { error: "invalid JSON" });
    }

    switch (msg.type) {
      case "message":
        return this.handleMessage(ws, threadId, msg.content as string, msg.parentCheckpointId as string | undefined);
      case "fork":
        return this.handleFork(ws, threadId, msg.checkpointId as string);
      case "get_messages":
        return this.handleGetMessages(ws, threadId);
      case "get_history":
        return this.handleGetHistory(ws, threadId);
      default:
        return this.send(ws, "error", { error: `unknown type: ${msg.type}` });
    }
  }

  async webSocketClose(): Promise<void> {
    // compat date >= 2026-04-07: runtime auto-replies to Close frames
  }

  // --- Handlers ---

  private async handleMessage(
    ws: WebSocket,
    threadId: string,
    content: string,
    parentCheckpointId?: string
  ): Promise<void> {
    if (!content) return this.send(ws, "error", { error: "missing content" });

    // If parentCheckpointId is provided, continue from that checkpoint (fork).
    // Otherwise continue from the latest.
    const current = parentCheckpointId
      ? await this.saver.getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: parentCheckpointId },
        })
      : await this.loadLatest(threadId);

    if (parentCheckpointId && !current) {
      return this.send(ws, "error", { error: "parent checkpoint not found" });
    }

    const messages = tupleMessages(current);
    const parentId = tupleCheckpointId(current);
    const step = current ? (current.metadata?.step ?? 0) + 1 : 0;

    const userMsg = { role: "user", content, ts: new Date().toISOString() };
    const reply = await this.callLLM([...messages, userMsg]);
    const assistantMsg = { role: "assistant", content: reply, ts: new Date().toISOString() };
    const newMessages = [...messages, userMsg, assistantMsg];

    const checkpointId = uuid6(step);
    await this.saveCheckpoint(threadId, checkpointId, newMessages, step, parentId);

    this.send(ws, "response", {
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      messageCount: newMessages.length,
      checkpointId,
    });
  }

  private async handleFork(ws: WebSocket, threadId: string, checkpointId: string): Promise<void> {
    if (!checkpointId) return this.send(ws, "error", { error: "missing checkpointId" });

    const target = await this.saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId },
    });
    if (!target) return this.send(ws, "error", { error: "checkpoint not found" });

    const messages = tupleMessages(target);
    this.send(ws, "forked", {
      checkpointId,
      messageCount: messages.length,
      messages,
    });
  }

  private async handleGetMessages(ws: WebSocket, threadId: string): Promise<void> {
    const current = await this.loadLatest(threadId);
    this.send(ws, "messages", { messages: tupleMessages(current) });
  }

  private async handleGetHistory(ws: WebSocket, threadId: string): Promise<void> {
    const history = [];
    for await (const tuple of this.saver.list(
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
      { limit: 50 }
    )) {
      history.push({
        checkpointId: tupleCheckpointId(tuple),
        parentCheckpointId: tuple.parentConfig?.configurable?.checkpoint_id ?? null,
        step: tuple.metadata?.step,
        messageCount: tupleMessages(tuple).length,
        ts: tuple.checkpoint.ts,
      });
    }
    this.send(ws, "history", { history });
  }

  // --- Internals ---

  private async loadLatest(threadId: string): Promise<CheckpointTuple | undefined> {
    return this.saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    });
  }

  private async saveCheckpoint(
    threadId: string,
    checkpointId: string,
    messages: unknown[],
    step: number,
    parentId?: string
  ): Promise<void> {
    await this.saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: parentId } },
      makeCheckpoint(checkpointId, messages, step),
      makeMetadata(step, parentId),
      { messages: step + 1 }
    );
  }

  private async callLLM(messages: unknown[]): Promise<string> {
    const baseUrl = this.env.OPENAI_BASE_URL ?? "http://localhost:17978";
    const input = messages.map((m) => {
      const msg = m as { role: string; content: string };
      return { role: msg.role, content: msg.content };
    });

    try {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "eliza", input }),
      });
      const json = (await res.json()) as {
        output: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
      };
      const msgOutput = json.output.find((o) => o.type === "message");
      return msgOutput?.content.find((c) => c.type === "output_text")?.text ?? "...";
    } catch {
      return `Echo: ${(messages[messages.length - 1] as { content: string }).content}`;
    }
  }

  private send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const match = url.pathname.match(/^\/thread\/([^/]+)$/);
    if (!match) {
      // Static assets (index.html, style.css, app.js) are served automatically
      // by the [assets] config in wrangler.toml — no code needed here.
      return new Response("Not found", { status: 404 });
    }

    const threadId = match[1];
    const stub = env.CHAT.get(env.CHAT.idFromName(threadId));
    return stub.fetch(request);
  },
};



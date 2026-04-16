/**
 * Cloudflare Worker + Durable Object: WebSocket chat with checkpointed state.
 *
 * GET /                        — Chat UI
 * GET /threads                 — List all threads (JSON)
 * POST /import?thread_id=...  — Import Claude Code session JSONL as a thread
 * ws://localhost:8787/thread/:threadId — WebSocket API
 *
 * Messages (send JSON):
 *   { "type": "message", "content": "hello" }                              — append to latest
 *   { "type": "message", "content": "hello", "parentCheckpointId": "..." } — append to specific checkpoint (branch)
 *   { "type": "fork", "checkpointId": "..." }                              — read state at a checkpoint
 *   { "type": "get_messages" }
 *   { "type": "get_history" }
 *
 * LLM: Cloudflare Workers AI with @moonshotai/kimi-k2.5
 */

import { DurableObject } from "cloudflare:workers";

import {
  IncrementalSqliteSaver,
  DurableObjectBackend,
} from "@langchain/langgraph-checkpoint-sqlite-incremental";
import { uuid6 } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  // thinking
  thinking?: string;
  // tool_use
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  // tool_use result (merged from tool_result)
  result?: string;
  is_error?: boolean;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
  ts: string;
}

/**
 * Parse a Claude Code session JSONL into a flat list of conversation messages.
 * Keeps text, thinking, and tool_use blocks. Tool results are merged into
 * their matching tool_use block rather than stored as separate messages.
 * Skips system, file-history-snapshot, and meta-injected messages.
 */
function parseSessionJsonl(body: string): { sessionId: string; messages: ConversationMessage[] } {
  const lines = body.split("\n").filter((l) => l.trim());
  const messages: ConversationMessage[] = [];
  let sessionId = "";

  // Index tool_use blocks by id so we can merge results into them
  const toolUseIndex = new Map<string, ContentBlock>();

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type as string;
    if (type !== "user" && type !== "assistant") continue;

    // Skip meta-injected messages (system prompts, skill expansions)
    if (obj.isMeta) continue;

    if (!sessionId && obj.sessionId) {
      sessionId = obj.sessionId as string;
    }

    const msg = obj.message as { role: string; content: unknown } | undefined;
    if (!msg) continue;

    const role = msg.role as "user" | "assistant";
    const ts = (obj.timestamp as string) ?? new Date().toISOString();

    const blocks: ContentBlock[] = [];
    let hasNonToolResult = false;

    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text) {
        blocks.push({ type: "text", text });
        hasNonToolResult = true;
      }
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content as Array<Record<string, unknown>>) {
        switch (c.type) {
          case "text":
            if ((c.text as string)?.trim()) {
              blocks.push({ type: "text", text: (c.text as string).trim() });
              hasNonToolResult = true;
            }
            break;
          case "thinking":
            if ((c.thinking as string)?.trim()) {
              blocks.push({ type: "thinking", thinking: (c.thinking as string).trim() });
              hasNonToolResult = true;
            }
            break;
          case "tool_use": {
            const block: ContentBlock = {
              type: "tool_use",
              tool_use_id: c.id as string,
              name: c.name as string,
              input: c.input,
            };
            blocks.push(block);
            toolUseIndex.set(block.tool_use_id!, block);
            hasNonToolResult = true;
            break;
          }
          case "tool_result": {
            // Merge into the matching tool_use block
            const useId = c.tool_use_id as string;
            const target = toolUseIndex.get(useId);
            const resultContent = typeof c.content === "string"
              ? c.content
              : JSON.stringify(c.content);
            if (target) {
              target.result = resultContent;
              target.is_error = c.is_error as boolean;
            }
            // Don't add as its own block
            break;
          }
        }
      }
    }

    // Only emit messages that have non-tool-result content
    if (blocks.length && hasNonToolResult) {
      messages.push({ role, content: blocks, ts });
    }
  }

  return { sessionId: sessionId || crypto.randomUUID(), messages };
}

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
  private saver: IncrementalSqliteSaver;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.saver = new IncrementalSqliteSaver(
      new DurableObjectBackend(ctx.storage),
      { listChannels: new Set(["messages"]) }
    );
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /import/:threadId — import a Claude Code session JSONL
    if (request.method === "POST" && url.pathname.endsWith("/import")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const threadId = parts[parts.length - 2];
      return this.handleImport(request, threadId);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
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
        return this.handleGetMessages(ws, threadId, msg.limit as number | undefined, msg.offset as number | undefined);
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

    // Register thread in registry on first message
    if (step === 0) {
      const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("singleton"));
      registry.upsert(threadId, undefined, 2, 1).catch(() => {});
    }

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

  private async handleGetMessages(
    ws: WebSocket,
    threadId: string,
    limit?: number,
    offset?: number
  ): Promise<void> {
    const current = await this.loadLatest(threadId);
    const all = tupleMessages(current);
    const total = all.length;

    if (limit != null) {
      // offset is from the end (0 = most recent batch)
      const off = offset ?? 0;
      const end = total - off;
      const start = Math.max(0, end - limit);
      this.send(ws, "messages", {
        messages: all.slice(start, end),
        total,
        offset: off,
        hasMore: start > 0,
      });
    } else {
      this.send(ws, "messages", { messages: all, total, offset: 0, hasMore: false });
    }
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

  // --- Import ---

  private async handleImport(request: Request, threadId: string): Promise<Response> {
    const body = await request.text();
    if (!body.trim()) {
      return Response.json({ error: "empty body" }, { status: 400 });
    }

    const { messages } = parseSessionJsonl(body);
    if (!messages.length) {
      return Response.json({ error: "no conversation messages found in JSONL" }, { status: 400 });
    }

    // Build checkpoints incrementally: each user+assistant pair is one step.
    // Unpaired trailing user messages get their own step too.
    let accumulated: unknown[] = [];
    let step = 0;
    let parentId: string | undefined;

    for (const msg of messages) {
      accumulated.push({ role: msg.role, content: msg.content, ts: msg.ts });

      // Commit a checkpoint after each assistant message, or at the very end
      // if the last message is from the user.
      const isAssistant = msg.role === "assistant";
      const isLast = msg === messages[messages.length - 1];

      if (isAssistant || isLast) {
        const checkpointId = uuid6(step);
        await this.saveCheckpoint(threadId, checkpointId, [...accumulated], step, parentId);
        parentId = checkpointId;
        step++;
      }
    }

    return Response.json({
      threadId,
      imported: messages.length,
      checkpoints: step,
    });
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
    const input = messages.map((m) => {
      const msg = m as { role: string; content: string | unknown[] };
      // Flatten structured content blocks to plain text for the LLM
      let text: string;
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b: unknown) => (b as { type: string }).type === "text")
          .map((b: unknown) => (b as { text: string }).text)
          .join("\n");
      } else {
        text = String(msg.content);
      }
      return { role: msg.role, content: text };
    });

    try {
      const res = await this.env.AI.run("@cf/moonshotai/kimi-k2.5" as Parameters<typeof this.env.AI.run>[0], {
        messages: input,
      });
      return (res as { response: string }).response ?? "...";
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// ---------------------------------------------------------------------------
// Thread Registry (singleton DO)
// ---------------------------------------------------------------------------

export class RegistryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        checkpoint_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async list() {
    return this.sql
      .exec("SELECT thread_id, label, message_count, checkpoint_count, created_at FROM threads ORDER BY created_at DESC")
      .toArray();
  }

  async upsert(threadId: string, label?: string, messageCount?: number, checkpointCount?: number) {
    this.sql.exec(
      `INSERT INTO threads (thread_id, label, message_count, checkpoint_count, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(thread_id) DO UPDATE SET
         label = CASE WHEN excluded.label != '' THEN excluded.label ELSE threads.label END,
         message_count = excluded.message_count,
         checkpoint_count = excluded.checkpoint_count`,
      threadId,
      label ?? "",
      messageCount ?? 0,
      checkpointCount ?? 0
    );
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const REALM = "checkpoint-do";

function checkBasicAuth(request: Request, env: Env): Response | null {
  const username = env.BASIC_AUTH_USERNAME;
  const password = env.BASIC_AUTH_PASSWORD;
  if (!username || !password) return null; // auth not configured, allow all

  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Basic realm="${REALM}"` },
    });
  }

  const decoded = atob(header.slice(6));
  const [u, ...pParts] = decoded.split(":");
  const p = pParts.join(":"); // password may contain colons
  if (u !== username || p !== password) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Basic realm="${REALM}"` },
    });
  }

  return null; // auth passed
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Basic auth on all routes
    const authErr = checkBasicAuth(request, env);
    if (authErr) return authErr;

    // GET /threads — list all threads from the registry
    if (request.method === "GET" && url.pathname === "/threads") {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("singleton"));
      const rows = await registry.list();
      return Response.json(rows);
    }

    // POST /import — import a Claude Code session JSONL as a new thread.
    if (request.method === "POST" && url.pathname === "/import") {
      const body = await request.text();
      const { sessionId } = parseSessionJsonl(body);
      const threadId = url.searchParams.get("thread_id") || sessionId;
      const label = url.searchParams.get("label") || threadId;
      const stub = env.CHAT.get(env.CHAT.idFromName(threadId));
      const res = await stub.fetch(
        new Request(`${url.origin}/thread/${threadId}/import`, {
          method: "POST",
          body,
          headers: request.headers,
        })
      );
      // Register the thread
      const result = (await res.clone().json()) as { imported?: number; checkpoints?: number };
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("singleton"));
      await registry.upsert(threadId, label, result.imported ?? 0, result.checkpoints ?? 0);
      return res;
    }

    // WebSocket: GET /thread/:id
    const match = url.pathname.match(/^\/thread\/([^/]+)$/);
    if (match) {
      const threadId = match[1];
      const stub = env.CHAT.get(env.CHAT.idFromName(threadId));
      return stub.fetch(request);
    }

    // Static assets — served after auth via ASSETS binding
    return env.ASSETS.fetch(request);
  },
};



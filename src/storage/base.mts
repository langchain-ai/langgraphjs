import type { CompiledGraph } from "@langchain/langgraph";
import { HTTPException } from "hono/http-exception";
import { v4 as uuid } from "uuid";

export type Metadata = Record<string, unknown>;

export type ThreadStatus = "idle" | "busy" | "interrupted";

export type RunStatus =
  | "pending"
  | "running"
  | "error"
  | "success"
  | "timeout"
  | "interrupted";

export type StreamMode = "values" | "messages" | "updates" | "events" | "debug";

export type MultitaskStrategy = "reject" | "rollback" | "interrupt" | "enqueue";

export type OnConflictBehavior = "raise" | "do_nothing";

export interface Config {
  tags?: string[];

  recursion_limit?: number;

  configurable?: {
    thread_id?: string;
    thread_ts?: string;
    [key: string]: unknown;
  };
}

interface Assistant {
  assistant_id: string;

  graph_id: string;

  config: Config;

  created_at: Date;

  updated_at: Date;

  metadata: Metadata;
}

export class Assistants {
  private STORE: Record<string, Assistant> = {};

  public async *search(options: {
    metadata?: Metadata;
    limit?: number;
    offset?: number;
  }) {
    for (const assistant of Object.values(this.STORE)) {
      yield assistant;
    }
  }

  public async get(assistantId: string): Promise<Assistant> {
    const result = this.STORE[assistantId];
    if (result == null)
      throw new HTTPException(404, { message: "Assistant not found" });
    return result;
  }

  public async put(
    assistantId: string,
    options: {
      config: Config;
      graphId: string;
      metadata?: Metadata;
      ifExists: OnConflictBehavior;
    }
  ): Promise<Assistant> {
    this.STORE[assistantId] ??= {
      assistant_id: assistantId,
      config: options.config ?? {},
      created_at: new Date(),
      updated_at: new Date(),
      graph_id: options.graphId,
      metadata: options.metadata ?? ({} as Metadata),
    };

    return this.STORE[assistantId];
  }

  public async patch(
    assistantId: string,
    options?: {
      config?: Config;
      graphId?: string;
      metadata?: Metadata;
    }
  ): Promise<Assistant> {
    const assistant = this.STORE[assistantId];
    if (!assistant)
      throw new HTTPException(404, { message: "Assistant not found" });

    if (options?.config != null) {
      assistant["config"] = options?.config ?? assistant["config"];
    }

    if (options?.graphId != null) {
      assistant["graph_id"] = options?.graphId ?? assistant["graph_id"];
    }

    if (options?.metadata != null) {
      assistant["metadata"] = options?.metadata ?? assistant["metadata"];
    }

    return assistant;
  }

  public async delete(assistantId: string): Promise<string[]> {
    const assistant = this.STORE[assistantId];
    if (!assistant)
      throw new HTTPException(404, { message: "Assistant not found" });
    delete this.STORE[assistantId];
    return [assistant.assistant_id];
  }
}

interface Thread {
  thread_id: string;

  created_at: Date;

  updated_at: Date;

  metadata?: Metadata;

  config?: Config;

  status: ThreadStatus;
}

export class Threads {
  private STORE: Record<string, Thread> = {};

  public async *search(options: {
    metadata?: Metadata;
    status?: ThreadStatus;
    limit?: number;
    offset?: number;
  }) {
    for (const thread of Object.values(this.STORE)) {
      yield thread;
    }
  }

  public async get(threadId: string) {
    return this.STORE[threadId];
  }

  public async put(
    threadId: string,
    options?: {
      metadata?: Metadata;
      ifExists: OnConflictBehavior;
    }
  ) {
    this.STORE[threadId] ??= {
      thread_id: threadId,
      created_at: new Date(),
      updated_at: new Date(),

      status: "idle",
    };
    if (options?.metadata != null) {
      this.STORE[threadId]["metadata"] = options?.metadata;
    }
    return this.STORE[threadId];
  }

  public async patch(
    threadId: string,
    options?: {
      metadata?: Metadata;
    }
  ) {
    const thread = this.STORE[threadId];
    if (!thread) throw new HTTPException(404, { message: "Thread not found" });
    if (options?.metadata != null) {
      thread["metadata"] = options?.metadata;
    }

    return thread;
  }

  public async setStatus(
    threadId: string,
    graph: CompiledGraph<string> | undefined
  ) {
    const thread = this.STORE[threadId];
    if (!thread) throw new HTTPException(404, { message: "Thread not found" });

    let hasNext = false;

    if (graph != null) {
      const state = await graph.getState({
        configurable: { thread_id: threadId },
      });
      hasNext = state.next.length > 0;
    }
    thread.status = hasNext ? "interrupted" : "idle";
  }

  public async delete(threadId: string) {
    delete this.STORE[threadId];
  }

  public async copy(threadId: string) {
    const newThreadId = uuid();
    this.STORE[newThreadId] = {
      ...this.STORE[threadId],
      created_at: new Date(),
      updated_at: new Date(),
      thread_id: newThreadId,
    };
  }
}

export class ThreadState {
  public async get(config: Config) {}
  public async post(
    config: Config,
    values?: Record<string, unknown>[] | Record<string, unknown> | undefined,
    asNode?: string | undefined
  ) {}
  public async patch(threadId: string, metadata: Metadata) {}
  public async list(
    threadId: string,
    options?: {
      limit: number;
      before?: string;
      metadata?: Metadata;
    }
  ) {}
}

export class Runs {
  async next() {}
  async put(
    assistantId: string,
    kwargs: Record<string, unknown>,
    options?: {
      threadId?: string;
      userId?: string;
      runId?: string;
      checkpointId?: string;
      status?: RunStatus;
      metadata?: Metadata;
      preventInsertInInflight?: boolean;
      multitaskStrategy?: MultitaskStrategy;
    }
  ) {}
  async get(options: { runId: string; threadId: string }) {}
  async delete(options: { runId: string; threadId: string }) {}
  async join(options: { runId: string; threadId: string }) {}
  async cancel(
    runIds: string[],
    options: {
      action: "interrupt" | "rollback";
      threadId: string;
      wait: boolean;
    }
  ) {}
  async search(
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      metadata?: Metadata;
    }
  ) {}
  async setStatus(runId: string, status: RunStatus) {}
}

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod/v3";

import { RunProtocolSession } from "../protocol/session.mjs";
import type { Run, RunsRepo, ThreadsRepo } from "../storage/types.mjs";

declare module "hono" {
  interface ContextVariableMap {
    protocolRun?: Run;
    protocolRepos?: {
      runs: RunsRepo;
      threads: ThreadsRepo;
    };
  }
}

const RunIdSchema = z.object({ run_id: z.string().uuid() });
const ThreadRunIdSchema = z.object({
  thread_id: z.string().uuid(),
  run_id: z.string().uuid(),
});

const createSessionHandlers = (
  c: any,
  repos: {
    runs: RunsRepo;
    threads: ThreadsRepo;
  },
  run: Run,
  threadId: string | undefined
) => {
  let session: RunProtocolSession | undefined;
  let started = false;
  const abortController = new AbortController();

  const startSession = (ws: {
    send: (source: string) => void;
  }) => {
    if (started) return;
    started = true;

    const source = repos.runs.stream.join(
      run.run_id,
      threadId,
      {
        signal: abortController.signal,
        cancelOnDisconnect: false,
        lastEventId: run.kwargs.resumable ? "-1" : undefined,
      },
      c.var.auth
    );

    session = new RunProtocolSession({
      runId: run.run_id,
      threadId,
      auth: c.var.auth,
      initialRun: run,
      getRun: () => repos.runs.get(run.run_id, threadId, c.var.auth),
      send: (payload) => ws.send(payload),
      source,
    });
    void session.start();
  };

  const closeSession = () => {
    abortController.abort();
    void session?.close();
  };

  return {
    onOpen(_event: Event, ws: { send: (source: string) => void }) {
      startSession(ws);
    },
    async onMessage(
      event: MessageEvent,
      ws: { send: (source: string) => void }
    ) {
      startSession(ws);
      const payload = await (async () => {
        if (typeof event.data === "string") return event.data;
        if (event.data instanceof ArrayBuffer) {
          return new TextDecoder().decode(new Uint8Array(event.data));
        }
        if (event.data instanceof Blob) {
          const buffer = await event.data.arrayBuffer();
          return new TextDecoder().decode(new Uint8Array(buffer));
        }
        return String(event.data);
      })();
      void session?.handleCommand(payload);
    },
    onClose() {
      closeSession();
    },
    onError() {
      closeSession();
    },
  };
};

const attachRun = (threaded: boolean) => {
  return async (c: any, next: () => Promise<void>) => {
    if (threaded) {
      const { thread_id, run_id } = c.req.valid("param");
      await c.var.LANGGRAPH_OPS.threads.get(thread_id, c.var.auth);
      const run = await c.var.LANGGRAPH_OPS.runs.get(
        run_id,
        thread_id,
        c.var.auth
      );
      if (run == null) {
        throw new HTTPException(404, { message: "Run not found" });
      }
      c.set("protocolRun", run);
      c.set("protocolRepos", {
        runs: c.var.LANGGRAPH_OPS.runs,
        threads: c.var.LANGGRAPH_OPS.threads,
      });
      await next();
      return;
    }

    const { run_id } = c.req.valid("param");
    const run = await c.var.LANGGRAPH_OPS.runs.get(run_id, undefined, c.var.auth);
    if (run == null) {
      throw new HTTPException(404, { message: "Run not found" });
    }
    c.set("protocolRun", run);
    c.set("protocolRepos", {
      runs: c.var.LANGGRAPH_OPS.runs,
      threads: c.var.LANGGRAPH_OPS.threads,
    });
    await next();
  };
};

export default function createProtocolApi(
  upgradeWebSocket: UpgradeWebSocket
) {
  const api = new Hono();

  api.get(
    "/runs/:run_id/protocol",
    zValidator("param", RunIdSchema),
    attachRun(false),
    upgradeWebSocket((c: any) =>
      createSessionHandlers(
        c,
        c.get("protocolRepos") as { runs: RunsRepo; threads: ThreadsRepo },
        c.get("protocolRun") as Run,
        undefined
      ) as any
    )
  );

  api.get(
    "/threads/:thread_id/runs/:run_id/protocol",
    zValidator("param", ThreadRunIdSchema),
    attachRun(true),
    upgradeWebSocket((c: any) =>
      createSessionHandlers(
        c,
        c.get("protocolRepos") as { runs: RunsRepo; threads: ThreadsRepo },
        c.get("protocolRun") as Run,
        c.req.valid("param").thread_id
      ) as any
    )
  );

  return api;
}

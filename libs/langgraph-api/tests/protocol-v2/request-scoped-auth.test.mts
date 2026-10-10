import { describe, expect, it } from "vitest";

import type { AuthContext } from "../../src/auth/index.mjs";
import { ProtocolService } from "../../src/protocol/service.mjs";
import type { Run, RunKwargs } from "../../src/storage/types.mjs";

const THREAD_ID = "00000000-0000-7000-8000-000000000002";

const makeAuth = (identity: string): AuthContext => ({
  user: {
    identity,
    permissions: [],
    display_name: identity,
    is_authenticated: true,
  },
  scopes: [],
});

describe("protocol request auth", () => {
  it("keeps concurrent run auth scoped to each request on one thread", async () => {
    const authA = makeAuth("user-a");
    const authB = makeAuth("user-b");
    const captured: Array<{
      auth: AuthContext | undefined;
      userId: string | undefined;
      runUser: unknown;
    }> = [];
    const bindings = {
      runs: {
        put: async (
          _runId: string,
          assistantId: string,
          kwargs: RunKwargs,
          options: { userId?: string },
          auth?: AuthContext
        ) => {
          captured.push({
            auth,
            userId: options.userId,
            runUser: kwargs.config?.configurable?.langgraph_auth_user,
          });
          return [
            {
              run_id: _runId,
              thread_id: THREAD_ID,
              assistant_id: assistantId,
              status: "pending",
              kwargs,
            } as unknown as Run,
          ];
        },
        get: async () => null,
        stream: {
          join: () => (async function* () {})(),
        },
      },
      threads: {
        state: {
          get: async () => ({ values: {} }),
        },
      },
    };
    const service = new ProtocolService(
      bindings as unknown as ConstructorParameters<typeof ProtocolService>[0]
    );
    service.ensureThread({ threadId: THREAD_ID, transport: "sse-http" });

    await Promise.all([
      service.handleCommand(
        THREAD_ID,
        {
          id: 1,
          method: "run.start",
          params: { assistant_id: "agent" },
        },
        authA
      ),
      service.handleCommand(
        THREAD_ID,
        {
          id: 2,
          method: "run.start",
          params: { assistant_id: "agent" },
        },
        authB
      ),
    ]);

    expect(captured).toEqual([
      { auth: authA, userId: "user-a", runUser: authA.user },
      { auth: authB, userId: "user-b", runUser: authB.user },
    ]);
  });
});

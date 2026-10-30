import { Hono } from "hono";
import { expect, it } from "vitest";

import createProtocolApi from "../../src/api/protocol.mjs";
import type { AuthContext } from "../../src/auth/index.mjs";
import type { Ops, Run, RunKwargs } from "../../src/storage/types.mjs";

const THREAD_ID = "00000000-0000-7000-8000-000000000003";

const userWithToken = (token: string | undefined) => ({
  identity: "user",
  permissions: [],
  display_name: "user",
  is_authenticated: true,
  token,
});

it("each command runs with the auth of the request that sent it", async () => {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(async (c, next) => {
    c.set("auth", {
      user: userWithToken(c.req.header("authorization")),
      scopes: [],
    });
    await next();
  });

  const send = (token: string, method: string, params: object) =>
    app.request(`/threads/${THREAD_ID}/commands`, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ id: 1, method, params }),
    });
  const startRun = (token: string) =>
    send(token, "run.start", { assistant_id: "agent", input: {} });

  const runAuth = new Map<string, object>();
  const stateReadAuth: unknown[] = [];
  let requestDuringFirst: ReturnType<typeof startRun> | undefined;
  const ops = {
    runs: {
      put: async (
        runId: string,
        _assistantId: string,
        kwargs: RunKwargs,
        _options: unknown,
        auth: AuthContext | undefined
      ) => {
        runAuth.set(runId, {
          authorizedAs: auth?.user,
          configuredAs: kwargs.config?.configurable?.langgraph_auth_user,
        });
        return [
          {
            run_id: runId,
            thread_id: THREAD_ID,
            status: "pending",
            kwargs,
          } as unknown as Run,
        ];
      },
      get: async () => null,
      stream: {
        join: (
          runId: string,
          _threadId: string,
          _options: unknown,
          auth: AuthContext | undefined
        ) => {
          runAuth.set(runId, { ...runAuth.get(runId), streamedAs: auth?.user });
          return (async function* () {})();
        },
      },
    },
    threads: {
      state: {
        get: async (
          _config: unknown,
          _options: unknown,
          auth: AuthContext | undefined
        ) => {
          stateReadAuth.push(auth?.user);
          if (requestDuringFirst == null) {
            requestDuringFirst = startRun("token-b");
            await requestDuringFirst;
          }
          return { tasks: [] };
        },
      },
    },
  } as unknown as Ops;
  app.route("/", createProtocolApi((() => () => new Response()) as never, ops));

  const authOfRunStartedBy = async (response: Response | undefined) =>
    runAuth.get((await response?.json())?.result?.run_id);
  const ranAs = (token: string) => ({
    authorizedAs: userWithToken(token),
    configuredAs: userWithToken(token),
    streamedAs: userWithToken(token),
  });

  const first = await startRun("token-a");
  expect(await authOfRunStartedBy(first)).toEqual(ranAs("token-a"));
  expect(await authOfRunStartedBy(await requestDuringFirst)).toEqual(
    ranAs("token-b")
  );

  await send("token-b", "state.get", {});
  await send("token-b", "input.respond", {
    interrupt_id: "interrupt-1",
    response: "yes",
  });
  expect(stateReadAuth).toEqual([
    userWithToken("token-a"),
    userWithToken("token-b"),
    userWithToken("token-b"),
    userWithToken("token-b"),
  ]);
});

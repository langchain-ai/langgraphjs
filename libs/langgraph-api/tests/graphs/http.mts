import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamText } from "hono/streaming";
import { Client } from "@langchain/langgraph-sdk";

let WEBHOOK_PAYLOAD: Record<string, unknown>;

export const app = new Hono<{
  Variables: {
    body: string | ArrayBuffer | ReadableStream | null;
  };
}>()
  .use(async (c, next) => {
    if (c.req.query("interrupt") != null) {
      return c.json({ status: "interrupted" });
    }

    await next();
    c.header("x-js-middleware", "true");
  })
  .use(async (c, next) => {
    const runsQuery = new RegExp(
      "^(/runs(/stream|/wait)?$|/runs/batch$|/threads/[^/]+/runs(/stream|/wait)?)$",
    );

    if (c.req.method === "POST" && c.req.path.match(runsQuery)) {
      const value = c.req.header("x-configurable-header");

      if (value != null) {
        const body = await c.req.json();

        body["config"] ??= {};
        body["config"]["configurable"] ??= {};
        body["config"]["configurable"]["x-configurable-header"] ??= value;
      }
    }

    await next();
  })
  .get("/custom/client", async (c) => {
    const result = await new Client().runs.wait(null, "agent_simple", {
      input: { messages: [{ role: "human", content: "input" }] },
    });

    return c.json({ result });
  })
  .get("/custom/my-route", (c) =>
    c.json(
      { foo: "bar" },
      {
        headers: {
          "x-custom-output": c.req.header("x-custom-input") as string,
        },
      },
    ),
  )
  .get("/runs/afakeroute", (c) => c.json({ foo: "afakeroute" }))
  .get("/custom/error", () => {
    throw new HTTPException(400, { message: "Bad request" });
  })
  .get("/custom/streaming", (c) =>
    streamText(c, async (stream) => {
      for (let i = 0; i < 4; i++) {
        await stream.writeln(`Count: ${i}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await stream.close();
    }),
  )
  .post("/custom/webhook", async (c) => {
    WEBHOOK_PAYLOAD = await c.req.json();
    return c.json({ status: "success" });
  })
  .get("/custom/webhook-payload", (c) => c.json(WEBHOOK_PAYLOAD))
  .notFound((c) => c.json({ status: "not-found" }));

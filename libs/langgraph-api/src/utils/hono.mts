import type { Context } from "hono";
import { serialiseAsDict } from "./serde.mjs";
import { stream } from "hono/streaming";
import { StreamingApi } from "hono/utils/stream";

export function jsonExtra<T>(c: Context, object: T) {
  return new Response(serialiseAsDict(object), {
    ...c.res,
    headers: { ...c.res.headers, "Content-Type": "application/json" },
  });
}

export function waitKeepAlive(c: Context, promise: Promise<unknown>) {
  return stream(c, async (stream) => {
    // keep sending newlines until we resolved the chunk
    let keepAlive: Promise<any> = Promise.resolve();

    const timer = setInterval(() => {
      keepAlive = keepAlive.then(() => stream.write("\n"));
    }, 1000);

    const result = await promise;
    clearInterval(timer);

    await keepAlive;
    await stream.write(serialiseAsDict(result));
  });
}

export const getDisconnectAbortSignal = (c: Context, stream: StreamingApi) => {
  // https://github.com/honojs/hono/issues/1770
  stream.onAbort(() => {});
  return c.req.raw.signal;
};

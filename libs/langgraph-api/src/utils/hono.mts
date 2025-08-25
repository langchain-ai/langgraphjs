import type { Context } from "hono";
import { stream } from "hono/streaming";
import { StreamingApi } from "hono/utils/stream";
import { serialiseAsDict } from "./serde.mjs";

export function jsonExtra<T>(c: Context, object: T) {
  c.header("Content-Type", "application/json");
  return c.body(serialiseAsDict(object));
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

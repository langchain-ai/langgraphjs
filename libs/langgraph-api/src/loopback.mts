import { Hono } from "hono";

const fetchSmb = Symbol.for("langgraph_api:fetch");
const global = globalThis as unknown as {
  [fetchSmb]?: (url: string, init?: RequestInit) => Promise<Response>;
};

export function getLoopbackFetch() {
  if (!global[fetchSmb]) throw new Error("Loopback fetch is not bound");
  return global[fetchSmb];
}

export const bindLoopbackFetch = (app: Hono) => {
  global[fetchSmb] = async (url: string, init?: RequestInit) =>
    app.request(url, init);
};

import { Hono } from "hono";

export let LOOPBACK_FETCH:
  | ((url: string, init?: RequestInit) => Promise<Response> | undefined)
  | undefined;

export const bindLoopbackFetch = (app: Hono) => {
  LOOPBACK_FETCH = async (url: string, init?: RequestInit) =>
    app.request(url, init);
};

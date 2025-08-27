import { MiddlewareHandler } from "hono";
import { cors as honoCors } from "hono/cors";

export const cors = (
  cors:
    | {
        allow_origins?: string[];
        allow_origin_regex?: string;
        allow_methods?: string[];
        allow_headers?: string[];
        allow_credentials?: boolean;
        expose_headers?: string[];
        max_age?: number;
      }
    | undefined
): MiddlewareHandler => {
  if (cors == null) {
    return honoCors({
      origin: "*",
      exposeHeaders: ["content-location", "x-pagination-total"],
    });
  }

  const originRegex = cors.allow_origin_regex
    ? new RegExp(cors.allow_origin_regex)
    : undefined;

  const origin = originRegex
    ? (origin: string) => {
        originRegex.lastIndex = 0; // reset regex in case it's a global regex
        if (originRegex.test(origin)) return origin;
        return undefined;
      }
    : cors.allow_origins;

  if (cors.expose_headers?.length) {
    const headersSet = new Set(cors.expose_headers.map((h) => h.toLowerCase()));

    if (!headersSet.has("content-location")) {
      console.warn(
        "Adding missing `Content-Location` header in `cors.expose_headers`."
      );
      cors.expose_headers.push("content-location");
    }
    if (!headersSet.has("x-pagination-total")) {
      console.warn(
        "Adding missing `X-Pagination-Total` header in `cors.expose_headers`."
      );
      cors.expose_headers.push("x-pagination-total");
    }
  }

  const config: Parameters<typeof honoCors>[0] = { origin: origin ?? "*" };
  if (cors.max_age != null) config.maxAge = cors.max_age;
  if (cors.allow_methods != null) config.allowMethods = cors.allow_methods;
  if (cors.allow_headers != null) config.allowHeaders = cors.allow_headers;
  if (cors.expose_headers != null) config.exposeHeaders = cors.expose_headers;
  if (cors.allow_credentials != null) {
    config.credentials = cors.allow_credentials;
  }

  return honoCors(config);
};

// This is used to match the behavior of the original LangGraph API
// where the content-type is not being validated. Might be nice
// to warn about this in the future and throw an error instead.
export const ensureContentType = (): MiddlewareHandler => {
  return async (c, next) => {
    if (
      c.req.header("content-type")?.startsWith("text/plain") &&
      c.req.method !== "GET" &&
      c.req.method !== "OPTIONS"
    ) {
      c.req.raw.headers.set("content-type", "application/json");
    }

    await next();
  };
};

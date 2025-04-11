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
    | undefined,
): MiddlewareHandler => {
  if (cors == null) return honoCors();

  const originRegex = cors.allow_origin_regex
    ? new RegExp(cors.allow_origin_regex)
    : undefined;

  const origin = originRegex
    ? (origin: string) => {
        originRegex.lastIndex = 0; // reset regex in case it's a global regex
        if (originRegex.test(origin)) return origin;
        return undefined;
      }
    : (cors.allow_origins ?? []);

  // TODO: handle `cors.allow_credentials`
  return honoCors({
    origin,
    maxAge: cors.max_age,
    allowMethods: cors.allow_methods,
    allowHeaders: cors.allow_headers,
    credentials: cors.allow_credentials,
    exposeHeaders: cors.expose_headers,
  });
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

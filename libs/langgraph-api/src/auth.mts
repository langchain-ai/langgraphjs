import type {
  Auth,
  ResourceActionType,
  HTTPException as AuthHTTPException,
} from "@langchain/langgraph-sdk/auth";
import type { MiddlewareHandler } from "hono";
import * as url from "node:url";
import * as path from "path";

import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

let CUSTOM_AUTH: Auth | undefined;

export type AuthFilters =
  | Record<string, string | { $eq?: string; $contains?: string }>
  | undefined;

export type AuthContext =
  | {
      user: {
        identity: string;
        permissions: string[];
        display_name: string;
        is_authenticated: boolean;
        [key: string]: unknown;
      };
      scopes: string[];
    }
  | undefined;

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export const handleAuthEvent = async <T extends keyof ResourceActionType>(
  context: AuthContext,
  key: T,
  value: ResourceActionType[T],
): Promise<[AuthFilters | undefined, value: ResourceActionType[T]]> => {
  // find filters and execute them
  if (!CUSTOM_AUTH) return [undefined, value];
  const handlers = CUSTOM_AUTH["~handlerCache"];

  const [resource, action] = key.split(":");
  const cbKey = [`${resource}:${action}`, resource, `*:${action}`, "*"].find(
    (priority) => handlers.callbacks?.[priority],
  );
  const handler = cbKey ? handlers.callbacks?.[cbKey] : undefined;
  if (!handler) return [undefined, value];

  if (!context) throw new HTTPException(403);
  const result = await handler({
    resource,
    action,
    value,
    permissions: context.scopes,
    user: context.user,
  });
  if (result == null || result == true) return [undefined, value];
  if (result === false) throw new HTTPException(403);

  if (typeof result !== "object") {
    throw new HTTPException(500, {
      message: `Auth handler returned invalid result. Expected fitler object, null, undefined or boolean. Got "${typeof result}" instead.`,
    });
  }

  return [result as AuthFilters, value];
};

export function isAuthMatching(
  metadata: Record<string, unknown> | undefined,
  filters: AuthFilters,
) {
  if (filters == null) return true;
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "object" && value != null) {
      if (value.$eq) {
        if (metadata?.[key] !== value.$eq) return false;
      } else if (value.$contains) {
        if (
          !Array.isArray(metadata?.[key]) ||
          !metadata?.[key].includes(value.$contains)
        ) {
          return false;
        }
      }
    } else {
      if (metadata?.[key] !== value) return false;
    }
  }

  return true;
}

const isHTTPAuthException = (error: unknown): error is AuthHTTPException => {
  return (
    typeof error === "object" &&
    error != null &&
    "status" in error &&
    "headers" in error
  );
};

export const auth = (): MiddlewareHandler => {
  return async (c, next) => {
    if (!CUSTOM_AUTH) return next();

    // get auth instance
    const handlers = CUSTOM_AUTH["~handlerCache"];
    if (!handlers.authenticate) return next();

    try {
      const response = await handlers.authenticate(c.req.raw);

      // normalize auth response
      const { scopes, user } = (() => {
        if (typeof response === "string") {
          return {
            scopes: [],
            user: {
              permissions: [],
              identity: response,
              display_name: response,
              is_authenticated: true,
            },
          };
        }

        if ("identity" in response && typeof response.identity === "string") {
          const scopes =
            "permissions" in response && Array.isArray(response.permissions)
              ? response.permissions
              : [];

          return {
            scopes,
            user: {
              ...response,
              permissions: scopes,
              is_authenticated: response.is_authenticated ?? true,
              display_name: response.display_name ?? response.identity,
            },
          };
        }

        throw new Error(
          "Invalid auth response received. Make sure to either return a `string` or an object with `identity` property.",
        );
      })();

      c.set("auth", { scopes, user });
      return next();
    } catch (error) {
      if (isHTTPAuthException(error)) {
        throw new HTTPException(error.status as ContentfulStatusCode, {
          message: error.message,
          res: new Response(error.message || "Unauthorized", {
            status: error.status,
            headers: error.headers,
          }),
        });
      }
      throw error;
    }
  };
};

export async function loadAuth(
  auth: { path?: string; disable_studio_auth?: boolean },
  options: { cwd: string },
) {
  if (!auth.path) return;

  // TODO: handle options.auth.disable_studio_auth
  const [userFile, exportSymbol] = auth.path.split(":", 2);
  const sourceFile = path.resolve(options.cwd, userFile);

  const module = (await import(url.pathToFileURL(sourceFile).toString()).then(
    (module) => module[exportSymbol || "default"],
  )) as Auth | undefined;

  if (!module) throw new Error(`Failed to load auth: ${auth.path}`);
  if (!("~handlerCache" in module))
    throw new Error(`Auth must be an instance of Auth: ${auth.path}`);

  CUSTOM_AUTH = module;
}

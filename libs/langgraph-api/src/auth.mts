import type { Auth, ResourceActionType } from "@langchain/langgraph-sdk/auth";
import type { MiddlewareHandler } from "hono";
import * as url from "node:url";
import * as path from "path";

import { HTTPException } from "hono/http-exception";

let CUSTOM_AUTH: Auth | undefined;

export type AuthFilters =
  | Record<string, string | { $eq?: string; $contains?: string }>
  | undefined;

export type AuthContext = Record<string, unknown> | undefined;

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export const handleAuthEvent = async <T extends keyof ResourceActionType>(
  context: AuthContext,
  key: T,
  data: ResourceActionType[T],
): Promise<AuthFilters | undefined> => {
  // find filters and execute them
  if (!CUSTOM_AUTH) return undefined;
  const handlers = CUSTOM_AUTH["~handlerCache"];

  const [resource, action] = key.split(":");
  const cbKey = [`${resource}:${action}`, resource, `*:${action}`, "*"].find(
    (priority) => handlers.callbacks?.[priority],
  );
  const handler = cbKey ? handlers.callbacks?.[cbKey] : undefined;
  if (!handler) return undefined;

  const result = await handler({ resource, action, data, context });
  if (result == null || result == true) return undefined;
  if (result === false) throw new HTTPException(403);

  if (typeof result !== "object") {
    throw new HTTPException(500, {
      message: `Auth handler returned invalid result. Expected fitler object, null, undefined or boolean. Got "${typeof result}" instead.`,
    });
  }

  return result as AuthFilters;
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

export const auth = (): MiddlewareHandler => {
  return async (c, next) => {
    if (!CUSTOM_AUTH) return next();

    // get auth instance
    const handlers = CUSTOM_AUTH["~handlerCache"];
    if (!handlers.authenticate) return next();

    c.set("auth", await handlers.authenticate(c.req.raw));
    return next();
  };
};

export async function loadAuth(
  auth: {
    path?: string;
    disable_studio_auth?: boolean;
  },
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

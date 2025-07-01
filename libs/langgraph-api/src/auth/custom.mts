import type { AuthEventValueMap } from "@langchain/langgraph-sdk/auth";
import type { MiddlewareHandler } from "hono";

import {
  authorize,
  authenticate,
  isAuthRegistered,
  isStudioAuthDisabled,
  type AuthContext,
  type AuthFilters,
} from "./index.mjs";

declare module "hono" {
  interface ContextVariableMap {
    auth?: AuthContext | undefined;
  }
}

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

export const handleAuthEvent = async <T extends keyof AuthEventValueMap>(
  context: AuthContext | undefined,
  event: T,
  value: AuthEventValueMap[T],
): Promise<[AuthFilters | undefined, value: AuthEventValueMap[T]]> => {
  const [resource, action] = event.split(":");
  const result = await authorize({
    resource,
    action,
    context,
    value,
  });

  return [result.filters, result.value] as [
    AuthFilters | undefined,
    value: AuthEventValueMap[T],
  ];
};

const STUDIO_USER = {
  display_name: "langgraph-studio-user",
  identity: "langgraph-studio-user",
  permissions: [],
  is_authenticated: true,
};

export const auth = (): MiddlewareHandler => {
  return async (c, next) => {
    if (!isAuthRegistered()) return next();

    if (
      !isStudioAuthDisabled() &&
      c.req.header("x-auth-scheme") === "langsmith"
    ) {
      c.set("auth", {
        user: STUDIO_USER,
        scopes: STUDIO_USER.permissions.slice(),
      });
      return next();
    }

    const auth = await authenticate(c.req.raw);
    c.set("auth", auth);
    return next();
  };
};

export { registerAuth } from "./index.mjs";

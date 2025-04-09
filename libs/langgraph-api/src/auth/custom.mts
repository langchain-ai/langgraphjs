import type { AuthEventValueMap } from "@langchain/langgraph-sdk/auth";
import type { MiddlewareHandler } from "hono";

import {
  authorize,
  authenticate,
  type AuthContext,
  type AuthFilters,
} from "./index.mjs";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext | undefined;
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
  action: T,
  value: AuthEventValueMap[T],
): Promise<[AuthFilters | undefined, value: AuthEventValueMap[T]]> => {
  const result = await authorize({
    resource: action,
    action,
    context,
    value,
  });

  return [result.filters, result.value] as [
    AuthFilters | undefined,
    value: AuthEventValueMap[T],
  ];
};

export const auth = (): MiddlewareHandler => {
  return async (c, next) => {
    c.set("auth", await authenticate(c.req.raw));
    return next();
  };
};

export { registerAuth } from "./index.mjs";

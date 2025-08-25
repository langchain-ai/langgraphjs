import type { MiddlewareHandler } from "hono";

import {
  authenticate,
  isAuthRegistered,
  isStudioAuthDisabled,
  type AuthContext,
} from "./index.mjs";

declare module "hono" {
  interface ContextVariableMap {
    auth?: AuthContext | undefined;
  }
}

const STUDIO_USER = {
  kind: "StudioUser",
  display_name: "langgraph-studio-user",
  identity: "langgraph-studio-user",
  permissions: [],
  is_authenticated: true,
};

export const auth = (): MiddlewareHandler => {
  return async (c, next) => {
    if (!isAuthRegistered()) return next();

    // skip for /info
    if (c.req.path === "/info") return next();

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

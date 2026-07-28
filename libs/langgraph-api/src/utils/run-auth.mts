import type { AuthContext } from "../auth/index.mjs";
import type { RunnableConfig } from "../storage/types.mjs";

const BLOCKED_CONFIGURABLE_HEADERS = new Set([
  "x-api-key",
  "x-tenant-id",
  "x-service-key",
]);

/**
 * Copy allowed request headers into `config.configurable`, matching the REST
 * runs API (`createValidRun`). Used by both REST and protocol-v2 run creation.
 */
export function applyRequestHeadersToRunConfig(
  config: RunnableConfig,
  headers: Headers | undefined
): void {
  if (!headers) return;

  for (const [rawKey, value] of headers.entries()) {
    const key = rawKey.toLowerCase();
    if (key.startsWith("x-")) {
      if (BLOCKED_CONFIGURABLE_HEADERS.has(key)) continue;
      config.configurable ??= {};
      config.configurable[key] = value;
    } else if (key === "user-agent") {
      config.configurable ??= {};
      config.configurable[key] = value;
    }
  }
}

/**
 * Stamp the authenticated user onto `config.configurable` so graph nodes and
 * tools can read `langgraph_auth_user`. Returns the resolved user id for run
 * metadata when auth is present.
 */
export function applyAuthToRunConfig(
  config: RunnableConfig,
  auth: AuthContext | undefined
): string | undefined {
  if (!auth) return undefined;

  const userId =
    auth.user.identity ??
    (typeof auth.user.id === "string" ? auth.user.id : undefined);

  config.configurable ??= {};
  config.configurable.langgraph_auth_user = auth.user;
  config.configurable.langgraph_auth_user_id = userId;
  config.configurable.langgraph_auth_permissions = auth.scopes;

  return userId;
}

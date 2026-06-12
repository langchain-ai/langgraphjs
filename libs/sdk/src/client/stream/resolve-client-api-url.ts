import type { AgentServerAdapter } from "./transport.js";

/**
 * Resolve the LangGraph SDK `Client` base URL for hydration and history
 * reads when the caller uses a custom {@link AgentServerAdapter}.
 *
 * Explicit `apiUrl` wins; otherwise inherit from adapters that expose
 * `apiUrl` (e.g. {@link HttpAgentServerAdapter}).
 */
export function resolveClientApiUrl(options: {
  apiUrl?: string;
  transport?: "sse" | "websocket" | AgentServerAdapter;
}): string | undefined {
  if (options.apiUrl != null) return options.apiUrl;

  const { transport } = options;
  if (transport != null && typeof transport === "object") {
    const candidate = (transport as { apiUrl?: unknown }).apiUrl;
    if (typeof candidate === "string") return candidate;
  }

  return undefined;
}

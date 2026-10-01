/**
 * Find the tool calls in a thread that show an app, without deciding where
 * they go.
 *
 * An APP belongs to a tool: it is the `ui://` resource that tool declares.
 * What varies per call is what is drawn from it, so this returns one entry
 * per CALL, each carrying its tool's resource plus that call's arguments and
 * result.
 *
 * Placement belongs to the application: a rendered app sits inside whatever
 * markup the conversation is made of, next to the turn that opened it. So it
 * goes in the loop a host already runs over a message's tool calls:
 *
 *     const mcpApps = useMCPApps(thread, { routes: "/mcp-app" });
 *
 *     {message.tool_calls.map((call) => {
 *       const app = mcpApps.forCall(call.id);
 *       return app
 *         ? <MCPApp key={call.id} app={app} callTool={mcpApps.callTool} />
 *         : <MyToolChip key={call.id} call={call} />;
 *     })}
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  mcpAppParts,
  type McpAppPart,
  type McpAppResource,
  type McpAppThread,
} from "../../ui/mcp-apps/bindings.js";

export interface UseMCPAppsOptions {
  /**
   * Where `langchain_mcp_apps` is mounted, and the hook does the rest: it
   * reads the tool list and every app's resource once, on mount.
   *
   * Up front rather than when a call needs one, because the window in which
   * a view can take its arguments as they stream is the gap between the
   * model naming a tool and the view being ready to hear, and fetching a
   * resource is the largest thing that fits in it.
   */
  routes?: string;
  /**
   * Tool name to the resource that tool opens, ALREADY READ.
   *
   * The escape hatch, for a host whose MCP access does not look like
   * `langchain_mcp_apps`: resolve them yourself and the hook fetches
   * nothing. Supply this or `routes`.
   */
  apps?: Record<string, McpAppResource>;
}

export interface MCPApps {
  /** Every call in the thread that shows an app, in the order made. */
  all: McpAppPart[];
  /**
   * What to draw for a tool call, or undefined for an ordinary tool.
   *
   * Also answers it for a `ToolMessage`, whose `tool_call_id` is the same
   * key: a truthy result means the view already shows that result.
   */
  forCall: (toolCallId: string) => McpAppPart | undefined;
  /**
   * Make a view's tool call, through the host's route.
   *
   * Hand it straight to `MCPApp`. Undefined when no `routes` was given,
   * because then the host owns that path too.
   */
  callTool?: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ content?: unknown[]; structuredContent?: unknown }>;
}

/** Read the tool list and every app's resource, once. */
async function readApps(
  routes: string
): Promise<Record<string, McpAppResource>> {
  const res = await fetch(`${routes}/tools`);
  if (!res.ok) throw new Error(`could not list tools (${res.status})`);
  const { app_uris } = (await res.json()) as {
    app_uris: Record<string, string>;
  };

  const read = Object.entries(app_uris).map(async ([name, uri]) => {
    const query = new URLSearchParams({ uri });
    const one = await fetch(`${routes}/resource?${query}`);
    if (!one.ok) throw new Error(`could not read ${uri} (${one.status})`);
    return [name, (await one.json()) as McpAppResource] as const;
  });
  return Object.fromEntries(await Promise.all(read));
}

export function useMCPApps(
  thread: McpAppThread,
  options: UseMCPAppsOptions
): MCPApps {
  const { routes, apps: given } = options;
  const [fetched, setFetched] = useState<Record<string, McpAppResource>>({});

  useEffect(() => {
    if (!routes) return;
    let live = true;
    void readApps(routes).then(
      (found) => live && setFetched(found),
      // One unreadable resource leaves its tool drawn as an ordinary call,
      // which is the honest outcome: there is no app to show.
      () => {}
    );
    return () => {
      live = false;
    };
  }, [routes]);

  const callTool = useCallback(
    async (params: { name: string; arguments: Record<string, unknown> }) => {
      const res = await fetch(`${routes}/call-tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      // A refusal is an error, not a result: returning the 403 body would
      // hand the view `{error}` where it expects `structuredContent`.
      if (!res.ok)
        throw new Error(
          (await res.json()).error ?? `call failed (${res.status})`
        );
      return res.json();
    },
    [routes]
  );

  const apps = given ?? fetched;
  return useMemo(() => {
    const all = mcpAppParts(thread, apps);
    const byCall = new Map<string, McpAppPart>();
    for (const part of all) byCall.set(part.toolCallId, part);

    return {
      all,
      forCall: (toolCallId: string) => byCall.get(toolCallId),
      ...(routes ? { callTool } : {}),
    };
  }, [thread, apps, routes, callTool]);
}

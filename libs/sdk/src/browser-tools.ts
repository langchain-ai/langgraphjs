/**
 * Browser Tools Support for LangGraph SDK
 *
 * This module provides types and utilities for handling browser tools
 * in the LangGraph SDK without requiring a dependency on langchain.
 *
 * Browser tools are tools that execute in the browser while the agent
 * runs on the server. They use LangGraph's interrupt mechanism to pause
 * execution, execute the tool client-side, and resume with the result.
 *
 * @module
 */

/**
 * Represents a browser tool interrupt payload.
 * This is the structure of the interrupt value when a browser tool is called.
 */
export interface BrowserToolInterrupt {
  /**
   * The type of interrupt. Always "browser_tool" for browser tools.
   */
  type: "browser_tool";

  /**
   * The tool call details.
   */
  toolCall: {
    /**
     * The unique ID of the tool call.
     */
    id: string | undefined;

    /**
     * The name of the tool being called.
     */
    name: string;

    /**
     * The arguments passed to the tool.
     */
    args: unknown;
  };
}

/**
 * A browser tool that can be registered with useStream.
 *
 * This interface is compatible with the BrowserTool type returned by
 * `browserTool()` from `langchain`, but doesn't require importing from langchain.
 *
 * Browser tools are created using the `browserTool()` function:
 *
 * @example
 * ```typescript
 * import { browserTool } from "langchain";
 * import { z } from "zod";
 *
 * const getLocation = browserTool(
 *   async ({ highAccuracy }) => {
 *     // Execute function runs in the browser
 *     return new Promise((resolve, reject) => {
 *       navigator.geolocation.getCurrentPosition(
 *         (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
 *         (err) => reject(new Error(err.message)),
 *         { enableHighAccuracy: highAccuracy }
 *       );
 *     });
 *   },
 *   {
 *     name: "get_location",
 *     description: "Get the user's current GPS location",
 *     schema: z.object({
 *       highAccuracy: z.boolean().optional(),
 *     }),
 *   }
 * );
 *
 * // Register with useStream
 * const stream = useStream({
 *   assistantId: "agent",
 *   browserTools: [getLocation],
 * });
 * ```
 */
export interface BrowserTool<Args = unknown, Output = unknown> {
  /**
   * The name of the tool. Must match the name used in the agent.
   */
  name: string;

  /**
   * Execute the tool in the browser.
   * This is the function passed as the first argument to `browserTool()`.
   *
   * @param args - The arguments passed to the tool (validated by the schema on the server)
   * @returns A promise that resolves with the tool output
   */
  execute: (args: Args) => Promise<Output>;
}

/**
 * A permissive browser tool type that accepts any browser tool regardless of its
 * specific type parameters. Use this when you need to store or pass arrays of
 * browser tools with different argument types.
 *
 * This type uses `any` for the args parameter to avoid contravariance issues
 * when mixing browser tools with different argument schemas.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBrowserTool = BrowserTool<any, any>;

/**
 * Event emitted during browser tool execution lifecycle.
 */
export interface BrowserToolEvent {
  /**
   * Which phase of execution.
   */
  phase: "start" | "success" | "error";

  /**
   * Tool name.
   */
  name: string;

  /**
   * Tool arguments (on all phases).
   */
  args: unknown;

  /**
   * Tool result (only on "success").
   */
  result?: unknown;

  /**
   * Error (only on "error").
   */
  error?: Error;

  /**
   * Execution duration in ms (on "success" or "error").
   */
  duration?: number;
}

/**
 * Callback for browser tool lifecycle events.
 */
export type OnBrowserToolCallback = (event: BrowserToolEvent) => void;

/**
 * Check if an interrupt value is a browser tool interrupt.
 *
 * @param interrupt - The interrupt value to check
 * @returns True if the interrupt is a browser tool interrupt
 */
export function isBrowserToolInterrupt(
  interrupt: unknown
): interrupt is BrowserToolInterrupt {
  if (typeof interrupt !== "object" || interrupt === null) {
    return false;
  }

  const value = interrupt as Record<string, unknown>;

  return (
    value.type === "browser_tool" &&
    typeof value.toolCall === "object" &&
    value.toolCall !== null &&
    typeof (value.toolCall as Record<string, unknown>).name === "string"
  );
}

/**
 * Find a browser tool by name from a list of registered tools.
 *
 * @param tools - List of registered browser tools
 * @param name - The name of the tool to find
 * @returns The matching tool or undefined
 */
export function findBrowserTool<Args = unknown, Output = unknown>(
  tools: BrowserTool[],
  name: string
): BrowserTool<Args, Output> | undefined {
  return tools.find((t) => t.name === name) as
    | BrowserTool<Args, Output>
    | undefined;
}

/**
 * Execute a browser tool and handle the result.
 *
 * @param tool - The browser tool to execute
 * @param args - The arguments to pass to the tool
 * @param onBrowserTool - Optional callback for lifecycle events
 * @returns A promise that resolves with the tool result or error
 */
export async function executeBrowserTool<Args = unknown, Output = unknown>(
  tool: BrowserTool<Args, Output>,
  args: Args,
  onBrowserTool?: OnBrowserToolCallback
): Promise<
  { success: true; result: Output } | { success: false; error: Error }
> {
  const startTime = Date.now();

  onBrowserTool?.({
    phase: "start",
    name: tool.name,
    args,
  });

  try {
    const result = await tool.execute(args);
    const duration = Date.now() - startTime;

    onBrowserTool?.({
      phase: "success",
      name: tool.name,
      args,
      result,
      duration,
    });

    return { success: true, result };
  } catch (err) {
    const error =
      err != null &&
      typeof err === "object" &&
      "message" in err &&
      typeof err.message === "string"
        ? (err as Error)
        : new Error(String(err));
    const duration = Date.now() - startTime;

    onBrowserTool?.({
      phase: "error",
      name: tool.name,
      args,
      error,
      duration,
    });

    return { success: false, error };
  }
}

/**
 * Handle a browser tool interrupt by executing the tool and returning
 * the command to resume the agent.
 *
 * @param interrupt - The browser tool interrupt
 * @param browserTools - List of registered browser tools
 * @param onBrowserTool - Optional callback for lifecycle events
 * @returns A promise that resolves with the resume command value
 */
export async function handleBrowserToolInterrupt(
  interrupt: BrowserToolInterrupt,
  browserTools: BrowserTool[],
  onBrowserTool?: OnBrowserToolCallback
): Promise<{ toolCallId: string | undefined; value: unknown }> {
  const { toolCall } = interrupt;
  const tool = findBrowserTool(browserTools, toolCall.name);

  if (!tool) {
    const error = new Error(
      `Browser tool "${toolCall.name}" is not registered. ` +
        `Available tools: ${
          browserTools.map((t) => t.name).join(", ") || "none"
        }`
    );

    onBrowserTool?.({
      phase: "error",
      name: toolCall.name,
      args: toolCall.args,
      error,
      duration: 0,
    });

    return {
      toolCallId: toolCall.id,
      value: { error: error.message },
    };
  }

  const result = await executeBrowserTool(tool, toolCall.args, onBrowserTool);

  if (result.success) {
    return {
      toolCallId: toolCall.id,
      value: result.result,
    };
  } else {
    return {
      toolCallId: toolCall.id,
      value: { error: result.error.message },
    };
  }
}

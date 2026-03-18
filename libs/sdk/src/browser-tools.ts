/**
 * Headless Tools Support for LangGraph SDK
 *
 * This module provides types and utilities for handling headless tools
 * in the LangGraph SDK. Headless tools are defined without an implementation
 * on the server; when the agent calls one it always interrupts and the client
 * provides the implementation via `.implement()`.
 *
 * @module
 */

/**
 * Represents a headless tool interrupt payload.
 * This is the structure of the interrupt value when a headless tool is called.
 */
export interface HeadlessToolInterrupt {
  /**
   * The type of interrupt. Always "tool" for headless tools.
   */
  type: "tool";

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
 * A headless tool implementation that pairs a tool definition with its
 * client-side execute function.
 *
 * Created by calling `.implement()` on a headless tool:
 *
 * @example
 * ```typescript
 * import { tool } from "langchain/tools";
 * import { z } from "zod";
 *
 * const getLocation = tool({
 *   name: "get_location",
 *   description: "Get the user's current GPS location",
 *   schema: z.object({
 *     highAccuracy: z.boolean().optional(),
 *   }),
 * });
 *
 * // Register with useStream
 * const stream = useStream({
 *   assistantId: "agent",
 *   tools: [
 *     getLocation.implement(async ({ highAccuracy }) => {
 *       return new Promise((resolve, reject) =>
 *         navigator.geolocation.getCurrentPosition(
 *           (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
 *           (err) => reject(new Error(err.message)),
 *           { enableHighAccuracy: highAccuracy }
 *         )
 *       );
 *     }),
 *   ],
 * });
 * ```
 */
export interface HeadlessToolImplementation<Args = unknown, Output = unknown> {
  /**
   * The headless tool definition. Must have a `name` property matching the
   * tool name used in the agent.
   */
  tool: {
    name: string;
  };

  /**
   * Execute the tool in the browser.
   *
   * @param args - The arguments passed to the tool (validated by the schema on the server)
   * @returns A promise that resolves with the tool output
   */
  execute: (args: Args) => Promise<Output>;
}

/**
 * A permissive headless tool implementation type that accepts any
 * implementation regardless of its specific type parameters.
 */
export type AnyHeadlessToolImplementation = HeadlessToolImplementation<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

/**
 * Event emitted during headless tool execution lifecycle.
 */
export interface ToolEvent {
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
 * Callback for headless tool lifecycle events.
 */
export type OnToolCallback = (event: ToolEvent) => void;

/**
 * Check if an interrupt value is a headless tool interrupt.
 *
 * @param interrupt - The interrupt value to check
 * @returns True if the interrupt is a headless tool interrupt
 */
export function isHeadlessToolInterrupt(
  interrupt: unknown
): interrupt is HeadlessToolInterrupt {
  if (typeof interrupt !== "object" || interrupt === null) {
    return false;
  }

  const value = interrupt as Record<string, unknown>;

  return (
    value.type === "tool" &&
    typeof value.toolCall === "object" &&
    value.toolCall !== null &&
    typeof (value.toolCall as Record<string, unknown>).name === "string"
  );
}

/**
 * Find a headless tool implementation by name.
 *
 * @param tools - List of registered headless tool implementations
 * @param name - The name of the tool to find
 * @returns The matching implementation or undefined
 */
export function findHeadlessTool<Args = unknown, Output = unknown>(
  tools: HeadlessToolImplementation[],
  name: string
): HeadlessToolImplementation<Args, Output> | undefined {
  return tools.find((t) => t.tool.name === name) as
    | HeadlessToolImplementation<Args, Output>
    | undefined;
}

/**
 * Execute a headless tool implementation and handle the result.
 *
 * @param impl - The headless tool implementation to execute
 * @param args - The arguments to pass to the tool
 * @param onTool - Optional callback for lifecycle events
 * @returns A promise that resolves with the tool result or error
 */
export async function executeHeadlessTool<Args = unknown, Output = unknown>(
  impl: HeadlessToolImplementation<Args, Output>,
  args: Args,
  onTool?: OnToolCallback
): Promise<
  { success: true; result: Output } | { success: false; error: Error }
> {
  const startTime = Date.now();

  onTool?.({
    phase: "start",
    name: impl.tool.name,
    args,
  });

  try {
    const result = await impl.execute(args);
    const duration = Date.now() - startTime;

    onTool?.({
      phase: "success",
      name: impl.tool.name,
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

    onTool?.({
      phase: "error",
      name: impl.tool.name,
      args,
      error,
      duration,
    });

    return { success: false, error };
  }
}

/**
 * Handle a headless tool interrupt by executing the implementation and
 * returning the command to resume the agent.
 *
 * @param interrupt - The headless tool interrupt
 * @param tools - List of registered headless tool implementations
 * @param onTool - Optional callback for lifecycle events
 * @returns A promise that resolves with the resume command value
 */
export async function handleHeadlessToolInterrupt(
  interrupt: HeadlessToolInterrupt,
  tools: HeadlessToolImplementation[],
  onTool?: OnToolCallback
): Promise<{ toolCallId: string | undefined; value: unknown }> {
  const { toolCall } = interrupt;
  const impl = findHeadlessTool(tools, toolCall.name);

  if (!impl) {
    const error = new Error(
      `Headless tool "${toolCall.name}" is not registered. ` +
        `Available tools: ${tools.map((t) => t.tool.name).join(", ") || "none"}`
    );

    onTool?.({
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

  const result = await executeHeadlessTool(impl, toolCall.args, onTool);

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

// ---------------------------------------------------------------------------
// Backward-compatible aliases (deprecated — use the renamed exports above)
// ---------------------------------------------------------------------------

/** @deprecated Use `HeadlessToolInterrupt` */
export type BrowserToolInterrupt = HeadlessToolInterrupt;
/** @deprecated Use `HeadlessToolImplementation` */
export type BrowserTool<
  Args = unknown,
  Output = unknown
> = HeadlessToolImplementation<Args, Output>;
/** @deprecated Use `AnyHeadlessToolImplementation` */
export type AnyBrowserTool = AnyHeadlessToolImplementation;
/** @deprecated Use `ToolEvent` */
export type BrowserToolEvent = ToolEvent;
/** @deprecated Use `OnToolCallback` */
export type OnBrowserToolCallback = OnToolCallback;
/** @deprecated Use `isHeadlessToolInterrupt` */
export const isBrowserToolInterrupt = isHeadlessToolInterrupt;
/** @deprecated Use `findHeadlessTool` */
export const findBrowserTool = findHeadlessTool;
/** @deprecated Use `executeHeadlessTool` */
export const executeBrowserTool = executeHeadlessTool;
/** @deprecated Use `handleHeadlessToolInterrupt` */
export const handleBrowserToolInterrupt = handleHeadlessToolInterrupt;

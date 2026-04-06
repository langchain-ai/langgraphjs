import type { Interrupt } from "./schema.js";

/**
 * Represents a headless tool interrupt payload emitted by LangChain's
 * schema-only `tool({ ... })` overload.
 *
 * Servers may serialize the nested tool call as `toolCall` (JS) or
 * `tool_call` (Python). Use {@link parseHeadlessToolInterruptPayload} to
 * normalize either shape before reading fields.
 */
export interface HeadlessToolInterrupt {
  type: "tool";
  toolCall: {
    id: string | undefined;
    name: string;
    args: unknown;
  };
}

/**
 * Parses a headless-tool interrupt `value` from the graph. Accepts both
 * `toolCall` (LangChain JS) and `tool_call` (Python / JSON snake_case).
 */
export function parseHeadlessToolInterruptPayload(
  value: unknown
): HeadlessToolInterrupt | null {
  if (typeof value !== "object" || value == null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (v.type !== "tool") {
    return null;
  }

  const rawTc = v.toolCall ?? v.tool_call;
  if (typeof rawTc !== "object" || rawTc == null) {
    return null;
  }
  const tc = rawTc as Record<string, unknown>;
  if (typeof tc.name !== "string") {
    return null;
  }

  const id = typeof tc.id === "string" ? tc.id : undefined;

  return {
    type: "tool",
    toolCall: {
      id,
      name: tc.name,
      args: tc.args,
    },
  };
}

/**
 * Client-side implementation returned by `headlessTool.implement(...)`.
 */
export interface HeadlessToolImplementation<Args = unknown, Output = unknown> {
  tool: {
    name: string;
  };
  execute: (args: Args) => Promise<Output>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHeadlessToolImplementation = HeadlessToolImplementation<
  any,
  any
>;

export interface ToolEvent {
  phase: "start" | "success" | "error";
  name: string;
  args: unknown;
  result?: unknown;
  error?: Error;
  duration?: number;
}

export type OnToolCallback = (event: ToolEvent) => void;

/**
 * Strip headless-tool interrupts from a user-facing interrupt list.
 */
export function filterOutHeadlessToolInterrupts<T extends { value?: unknown }>(
  interrupts: readonly T[]
): T[] {
  return interrupts.filter(
    (interrupt) =>
      interrupt.value == null || !isHeadlessToolInterrupt(interrupt.value)
  );
}

export function isHeadlessToolInterrupt(
  interrupt: unknown
): interrupt is HeadlessToolInterrupt {
  return parseHeadlessToolInterruptPayload(interrupt) != null;
}

export function findHeadlessTool<Args = unknown, Output = unknown>(
  tools: HeadlessToolImplementation[],
  name: string
): HeadlessToolImplementation<Args, Output> | undefined {
  return tools.find((tool) => tool.tool.name === name) as
    | HeadlessToolImplementation<Args, Output>
    | undefined;
}

export async function executeHeadlessTool<Args = unknown, Output = unknown>(
  implementation: HeadlessToolImplementation<Args, Output>,
  args: Args,
  onTool?: OnToolCallback
): Promise<
  { success: true; result: Output } | { success: false; error: Error }
> {
  const startTime = Date.now();

  onTool?.({
    phase: "start",
    name: implementation.tool.name,
    args,
  });

  try {
    const result = await implementation.execute(args);
    const duration = Date.now() - startTime;

    onTool?.({
      phase: "success",
      name: implementation.tool.name,
      args,
      result,
      duration,
    });

    return { success: true, result };
  } catch (err) {
    // oxlint-disable-next-line no-instanceof/no-instanceof
    const error = err instanceof Error ? err : new Error(String(err));
    const duration = Date.now() - startTime;

    onTool?.({
      phase: "error",
      name: implementation.tool.name,
      args,
      error,
      duration,
    });

    return { success: false, error };
  }
}

export async function handleHeadlessToolInterrupt(
  interrupt: HeadlessToolInterrupt,
  tools: HeadlessToolImplementation[],
  onTool?: OnToolCallback
): Promise<{ toolCallId: string | undefined; value: unknown }> {
  const { toolCall } = interrupt;
  const implementation = findHeadlessTool(tools, toolCall.name);

  if (!implementation) {
    const error = new Error(
      `Headless tool "${toolCall.name}" is not registered. ` +
        `Available tools: ${tools.map((tool) => tool.tool.name).join(", ") || "none"}`
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

  const result = await executeHeadlessTool(
    implementation,
    toolCall.args as never,
    onTool
  );

  if (result.success) {
    return {
      toolCallId: toolCall.id,
      value: result.result,
    };
  }

  return {
    toolCallId: toolCall.id,
    value: { error: result.error.message },
  };
}

export function headlessToolResumeCommand(result: {
  toolCallId: string | undefined;
  value: unknown;
}): { resume: unknown } {
  return {
    resume: result.toolCallId
      ? { [result.toolCallId]: result.value }
      : result.value,
  };
}

export interface FlushPendingHeadlessToolInterruptsOptions {
  onTool?: OnToolCallback;
  resumeSubmit: (command: { resume: unknown }) => void | Promise<void>;
  defer?: (run: () => void) => void;
}

/**
 * Execute and resume all newly seen headless-tool interrupts from a values
 * payload. Callers own `handledIds` and should clear it when the thread changes.
 */
export function flushPendingHeadlessToolInterrupts(
  values: Record<string, unknown> | null | undefined,
  tools: HeadlessToolImplementation[] | undefined,
  handledIds: Set<string>,
  options: FlushPendingHeadlessToolInterruptsOptions
): void {
  if (!tools?.length || !values) return;

  const interrupts = values.__interrupt__;
  if (!Array.isArray(interrupts) || interrupts.length === 0) return;

  const defer = options.defer ?? ((run) => run());

  for (const interrupt of interrupts as Interrupt[]) {
    const headlessInterrupt = parseHeadlessToolInterruptPayload(
      interrupt.value
    );
    if (!headlessInterrupt) continue;

    const interruptId = interrupt.id ?? headlessInterrupt.toolCall.id ?? "";
    if (handledIds.has(interruptId)) continue;
    handledIds.add(interruptId);

    defer(() => {
      void handleHeadlessToolInterrupt(
        headlessInterrupt,
        tools,
        options.onTool
      ).then((result) => {
        void options.resumeSubmit(headlessToolResumeCommand(result));
      });
    });
  }
}

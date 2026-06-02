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

/**
 * Resume command produced by {@link headlessToolResumeCommand} /
 * {@link headlessToolsBatchResumeCommand}.
 */
export interface HeadlessToolResumeCommand {
  resume: unknown;
  /**
   * When true, top-level {@link resume} keys are protocol interrupt ids and
   * must be sent through {@link HeadlessToolResumeController.respondAll}.
   */
  keyedByInterruptId?: boolean;
}

export function headlessToolResumeCommand(result: {
  toolCallId: string | undefined;
  value: unknown;
}): HeadlessToolResumeCommand {
  return {
    resume: result.toolCallId
      ? { [result.toolCallId]: result.value }
      : result.value,
    keyedByInterruptId: false,
  };
}

/**
 * Merge headless-tool results into one resume command. Use interrupt-id keys
 * whenever the stream provided them so the resume does not need to rediscover
 * a pending interrupt from mutable client state.
 */
export function headlessToolsBatchResumeCommand(
  entries: ReadonlyArray<{
    interruptId: string;
    toolCallId: string | undefined;
    value: unknown;
  }>
): HeadlessToolResumeCommand {
  if (entries.length === 0) {
    return { resume: {}, keyedByInterruptId: false };
  }

  const hasInterruptIds = entries.every(
    (entry) => entry.interruptId.length > 0
  );
  if (!hasInterruptIds && entries.length === 1) {
    const [entry] = entries;
    return headlessToolResumeCommand({
      toolCallId: entry.toolCallId,
      value: entry.value,
    });
  }

  const resume: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.interruptId.length === 0) continue;
    resume[entry.interruptId] =
      entry.toolCallId != null && entry.toolCallId.length > 0
        ? { [entry.toolCallId]: entry.value }
        : entry.value;
  }
  return { resume, keyedByInterruptId: true };
}

/**
 * Minimal controller surface for servicing a headless-tool resume on the
 * v1 stream protocol (`input.respond`).
 */
export interface HeadlessToolResumeController {
  respond: (
    response: unknown,
    options?: { interruptId?: string }
  ) => Promise<void>;
  respondAll: (responsesById: Record<string, unknown>) => Promise<void>;
}

/**
 * Resume a headless-tool batch on the v1 commands transport.
 *
 * {@link headlessToolsBatchResumeCommand} still returns a legacy
 * `{ resume }` command shape for callers on the old runs/stream API.
 * On v1 `StreamController`, that payload must be sent through
 * {@link HeadlessToolResumeController.respond} /
 * {@link HeadlessToolResumeController.respondAll} — not `submit(null,
 * { command })`, which dispatches `run.start` without a resume value.
 */
export function applyHeadlessToolResumeCommand(
  controller: HeadlessToolResumeController,
  command: HeadlessToolResumeCommand
): Promise<void> {
  const { resume, keyedByInterruptId } = command;
  if (resume == null) return Promise.resolve();

  const useRespondAll =
    keyedByInterruptId === true ||
    (keyedByInterruptId !== false && isInterruptIdKeyedResume(resume));

  if (useRespondAll) {
    return controller.respondAll(resume as Record<string, unknown>);
  }

  return controller.respond(resume);
}

/**
 * True when a resume payload is keyed by protocol interrupt id at the top
 * level (for {@link HeadlessToolResumeController.respondAll}).
 *
 * Prefer {@link HeadlessToolResumeCommand.keyedByInterruptId} from
 * {@link headlessToolsBatchResumeCommand} when ids are not inferable
 * (for example `{ "int-1": result }` without a nested tool-call map).
 *
 * When `interrupts` is provided, a single top-level key that matches a
 * known protocol interrupt id is treated as interrupt-keyed.
 */
export function isInterruptIdKeyedResume(
  resume: unknown,
  interrupts?: readonly ProtocolInterruptEntry[]
): boolean {
  if (resume == null || typeof resume !== "object" || Array.isArray(resume)) {
    return false;
  }
  const record = resume as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  if (keys.length > 1) return true;

  const [key] = keys;
  if (interrupts?.length) {
    const knownIds = new Set(interrupts.map((entry) => entry.interruptId));
    if (knownIds.has(key!)) return true;
  }

  // Legacy graph task ids from `values.__interrupt__`.
  return /^[0-9a-f]{32}$/i.test(key!);
}

/**
 * Normalize `command.resume` into the `run.start` input the API turns
 * into `Command({ resume })`. Interrupt-id keyed payloads pass through;
 * tool-call-keyed and generic payloads are wrapped under the matching
 * protocol interrupt id.
 */
export function buildResumeRunInput(
  resume: unknown,
  interrupts: readonly ProtocolInterruptEntry[],
  resolvedInterruptIds: ReadonlySet<string>
): Record<string, unknown> | null {
  if (resume == null) return null;
  if (isInterruptIdKeyedResume(resume, interrupts)) {
    return resume as Record<string, unknown>;
  }

  const target = resolveInterruptTargetForHeadlessResume(
    resume,
    interrupts,
    resolvedInterruptIds
  );
  if (target == null) return null;

  return { [target.interruptId]: resume };
}

/**
 * Reads the tool-call id from a headless-tool resume command shaped as
 * `{ [toolCallId]: result }`.
 */
export function extractHeadlessToolCallIdFromResumeCommand(
  resume: unknown
): string | undefined {
  if (resume == null || typeof resume !== "object" || Array.isArray(resume)) {
    return undefined;
  }
  const keys = Object.keys(resume as Record<string, unknown>);
  if (keys.length !== 1) return undefined;
  return keys[0];
}

/**
 * Protocol interrupt entry tracked on {@link ThreadStream.interrupts}.
 * Used by {@link resolveInterruptTargetForHeadlessResume} when `respond()`
 * omits an explicit target.
 */
export interface ProtocolInterruptEntry {
  interruptId: string;
  namespace: string[];
  payload: unknown;
}

/**
 * Pick the protocol interrupt that matches a headless-tool resume payload.
 * Falls back to the newest unresolved interrupt for non-keyed resumes.
 */
export function resolveInterruptTargetForHeadlessResume(
  resume: unknown,
  interrupts: readonly ProtocolInterruptEntry[],
  resolvedInterruptIds: ReadonlySet<string>
): { interruptId: string; namespace: string[] } | null {
  const toolCallId = extractHeadlessToolCallIdFromResumeCommand(resume);
  if (toolCallId != null) {
    for (let i = interrupts.length - 1; i >= 0; i -= 1) {
      const entry = interrupts[i];
      if (entry == null || resolvedInterruptIds.has(entry.interruptId)) {
        continue;
      }
      const headless = parseHeadlessToolInterruptPayload(entry.payload);
      if (headless?.toolCall.id === toolCallId) {
        return {
          interruptId: entry.interruptId,
          namespace: [...entry.namespace],
        };
      }
    }
  }

  for (let i = interrupts.length - 1; i >= 0; i -= 1) {
    const entry = interrupts[i];
    if (entry == null || resolvedInterruptIds.has(entry.interruptId)) {
      continue;
    }
    return {
      interruptId: entry.interruptId,
      namespace: [...entry.namespace],
    };
  }
  return null;
}

export interface FlushPendingHeadlessToolInterruptsOptions {
  onTool?: OnToolCallback;
  resumeSubmit: (command: HeadlessToolResumeCommand) => void | Promise<void>;
  defer?: (run: () => void) => void;
}

const coalescedHeadlessFlushes = new WeakMap<
  Set<string>,
  { scheduled: boolean; run: () => void }
>();

/**
 * Coalesce rapid headless-tool flush triggers into one microtask so parallel
 * `input.requested` events observed back-to-back batch into a single resume.
 * Vue/Svelte/Angular watchers run synchronously per event; without this,
 * the first interrupt can be claimed before the second arrives and resume
 * splits into staggered single-tool commands.
 */
export function scheduleCoalescedHeadlessToolFlush(
  handledIds: Set<string>,
  run: () => void
): void {
  let state = coalescedHeadlessFlushes.get(handledIds);
  if (state == null) {
    state = { scheduled: false, run: () => {} };
    coalescedHeadlessFlushes.set(handledIds, state);
  }
  state.run = run;
  if (state.scheduled) return;
  state.scheduled = true;
  void Promise.resolve().then(() => {
    state!.scheduled = false;
    state!.run();
  });
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
  const pending: Array<{
    interruptId: string;
    headlessInterrupt: HeadlessToolInterrupt;
    toolCallId: string;
  }> = [];
  const seenToolCallIds = new Set<string>();

  for (const interrupt of interrupts as Interrupt[]) {
    const headlessInterrupt = parseHeadlessToolInterruptPayload(
      interrupt.value
    );
    if (!headlessInterrupt) continue;

    const interruptId = interrupt.id ?? headlessInterrupt.toolCall.id ?? "";
    const toolCallId = headlessInterrupt.toolCall.id ?? "";
    if (handledIds.has(interruptId)) continue;
    // v2 protocol runs mirror the same headless-tool interrupt in both
    // `values.__interrupt__` and `rootStore.interrupts` with different
    // ids (graph/task id vs protocol interrupt_id). The headless-tool
    // effect can also re-run after the first resume clears
    // `rootStore.interrupts` while `values.__interrupt__` is still
    // present — persist tool call ids in the caller-owned set so we
    // only execute + resume once per pending tool call.
    if (toolCallId && handledIds.has(toolCallId)) continue;
    if (toolCallId && seenToolCallIds.has(toolCallId)) continue;
    if (toolCallId) seenToolCallIds.add(toolCallId);

    // Claim before defer so a second flush in the same tick cannot
    // schedule a duplicate execute/resume for the same interrupt.
    handledIds.add(interruptId);
    if (toolCallId) handledIds.add(toolCallId);

    pending.push({ interruptId, headlessInterrupt, toolCallId });
  }

  if (pending.length === 0) return;

  defer(() => {
    void (async () => {
      const results = await Promise.all(
        pending.map(async ({ interruptId, headlessInterrupt, toolCallId }) => {
          const result = await handleHeadlessToolInterrupt(
            headlessInterrupt,
            tools,
            options.onTool
          );
          return {
            interruptId,
            toolCallId: result.toolCallId ?? toolCallId,
            value: result.value,
          };
        })
      );
      await Promise.resolve(
        options.resumeSubmit(headlessToolsBatchResumeCommand(results))
      );
    })();
  });
}

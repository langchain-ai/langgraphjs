/**
 * A2A stream transformer — emits A2A protocol-compliant streaming events.
 *
 * Uses the official `@a2a-js/sdk` types to ensure emitted events satisfy
 * `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` shapes.
 *
 * Events are wrapped as `{ type: "a2a", payload: A2AStreamEvent }` on
 * the `custom` channel so clients can distinguish them from other custom
 * transformer output.
 */

import type { ProtocolEvent, StreamTransformer } from "@langchain/langgraph";
import { EventLog } from "@langchain/langgraph";
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";

type A2AStreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export const createA2ATransformer = (): StreamTransformer<{
  a2a: AsyncIterable<A2AStreamEvent>;
}> => {
  const log = new EventLog<A2AStreamEvent>();
  let started = false;

  let activeNode: string | undefined;
  let activeRole: string | undefined;
  let isToolCall = false;
  let accumulatedText = "";
  let artifactIndex = 0;

  /** Track which top-level subgraphs have been announced. */
  const announcedNodes = new Set<string>();

  const contextId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  const pushAndEmit = (
    event: A2AStreamEvent,
    emit?: (method: string, data: unknown) => void
  ) => {
    log.push(event);
    emit?.("a2a", event);
  };

  const makeStatusEvent = (
    state: TaskStatusUpdateEvent["status"]["state"],
    text: string,
    final: boolean
  ): TaskStatusUpdateEvent => ({
    kind: "status-update",
    contextId,
    taskId,
    final,
    status: {
      state,
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text }],
      },
      timestamp: new Date().toISOString(),
    },
  });

  const makeArtifactEvent = (
    text: string,
    lastChunk: boolean
  ): TaskArtifactUpdateEvent => ({
    kind: "artifact-update",
    contextId,
    taskId,
    lastChunk,
    append: !lastChunk,
    artifact: {
      artifactId: `${activeNode}-response-${artifactIndex}`,
      name: `${activeNode}-response`,
      parts: [{ kind: "text", text }],
    },
  });

  return {
    init: () => ({ a2a: log.toAsyncIterable() }),

    process(event: ProtocolEvent, emit) {
      if (!started) {
        started = true;
        pushAndEmit(
          makeStatusEvent("working", "Agent started processing", false),
          emit
        );
      }

      // Announce top-level subgraphs as they appear
      if (event.params.namespace.length >= 1) {
        const segment = event.params.namespace[0];
        const nodeName = segment.split(":")[0];
        if (!announcedNodes.has(nodeName)) {
          announcedNodes.add(nodeName);
          pushAndEmit(
            makeStatusEvent("working", `${nodeName} started`, false),
            emit
          );
        }
      }

      if (event.method === "messages") {
        const data = event.params.data as Record<string, unknown>;
        const ns = event.params.namespace;

        if (data.event === "message-start") {
          const segment = ns[0] ?? "agent";
          activeNode = segment.split(":")[0];
          activeRole = (data.role as string) ?? undefined;
          accumulatedText = "";
          isToolCall = false;
        }

        // Detect tool call content blocks — these produce tool_use
        // finish reasons and should not be emitted as text artifacts
        if (data.event === "content-block-start") {
          const cb = data.content_block as Record<string, unknown>;
          if (
            cb?.type === "tool_call_chunk" ||
            cb?.type === "tool_call" ||
            cb?.type === "tool_use"
          ) {
            isToolCall = true;
          }
        }

        // Only stream AI-authored text, skip tool calls and tool results
        if (
          activeRole === "ai" &&
          !isToolCall &&
          data.event === "content-block-delta"
        ) {
          const cb = data.content_block as Record<string, unknown>;
          if (cb?.type === "text" && typeof cb.text === "string") {
            accumulatedText += cb.text;
            pushAndEmit(makeArtifactEvent(cb.text, false), emit);
          }
        }

        if (
          activeRole === "ai" &&
          !isToolCall &&
          data.event === "message-finish" &&
          accumulatedText.length > 0
        ) {
          pushAndEmit(makeArtifactEvent(accumulatedText, true), emit);
          artifactIndex += 1;
          accumulatedText = "";
          activeNode = undefined;
          activeRole = undefined;
        }

        // Reset tool call flag on message finish regardless
        if (data.event === "message-finish") {
          isToolCall = false;
        }
      }

      return true;
    },

    finalize(emit?) {
      pushAndEmit(
        makeStatusEvent("completed", "Agent finished successfully", true),
        emit
      );
      log.close();
    },

    fail(err, emit?) {
      const message =
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : String(err);

      pushAndEmit(makeStatusEvent("failed", message, true), emit);
      log.close();
    },
  };
};

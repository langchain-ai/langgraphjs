/**
 * A2A stream transformer — emits A2A protocol-compliant streaming events.
 *
 * Uses the official `@a2a-js/sdk` types to ensure emitted events satisfy
 * `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` shapes.
 *
 * Events are surfaced via a remote {@link StreamChannel} named `"a2a"`:
 *   - In-process consumers iterate `run.extensions.a2a` directly.
 *   - Remote SDK clients subscribe via `thread.subscribe("custom:a2a")`.
 */

import type { ProtocolEvent, StreamTransformer } from "@langchain/langgraph";
import { StreamChannel } from "@langchain/langgraph";
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";

type A2AStreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export const createA2ATransformer = (): StreamTransformer<{
  a2a: StreamChannel<A2AStreamEvent>;
}> => {
  const a2a = StreamChannel.remote<A2AStreamEvent>("a2a");
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
    init: () => ({ a2a }),

    process(event: ProtocolEvent) {
      if (!started) {
        started = true;
        a2a.push(
          makeStatusEvent("working", "Agent started processing", false)
        );
      }

      if (event.params.namespace.length >= 1) {
        const segment = event.params.namespace[0];
        const nodeName = segment.split(":")[0];
        if (!announcedNodes.has(nodeName)) {
          announcedNodes.add(nodeName);
          a2a.push(makeStatusEvent("working", `${nodeName} started`, false));
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

        if (data.event === "content-block-start") {
          const cb = data.content as Record<string, unknown>;
          if (
            cb?.type === "tool_call_chunk" ||
            cb?.type === "tool_call" ||
            cb?.type === "tool_use"
          ) {
            isToolCall = true;
          }
        }

        if (
          activeRole === "ai" &&
          !isToolCall &&
          data.event === "content-block-delta"
        ) {
          const cb = data.content as Record<string, unknown>;
          if (cb?.type === "text" && typeof cb.text === "string") {
            accumulatedText += cb.text;
            a2a.push(makeArtifactEvent(cb.text, false));
          }
        }

        if (
          activeRole === "ai" &&
          !isToolCall &&
          data.event === "message-finish" &&
          accumulatedText.length > 0
        ) {
          a2a.push(makeArtifactEvent(accumulatedText, true));
          artifactIndex += 1;
          accumulatedText = "";
          activeNode = undefined;
          activeRole = undefined;
        }

        if (data.event === "message-finish") {
          isToolCall = false;
        }
      }

      return true;
    },

    finalize() {
      a2a.push(
        makeStatusEvent("completed", "Agent finished successfully", true)
      );
    },

    fail(err) {
      const message =
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : String(err);

      a2a.push(makeStatusEvent("failed", message, true));
    },
  };
};

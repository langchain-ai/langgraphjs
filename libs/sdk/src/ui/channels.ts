/**
 * A stream event in `@langchain/react` 1.x's channel shape. `timestamp` is
 * when the client received it.
 */
export interface ChannelEvent {
  method: "values" | "updates" | "messages" | "custom" | "tools" | "lifecycle";
  params: { namespace: string[]; timestamp: number; data: unknown };
}

type V1ToolEvent = {
  event?: string;
  toolCallId?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  data?: unknown;
};

type V1Lifecycle = {
  event?: string;
  tool_call_id?: string;
  error?: { message?: string };
};

/**
 * Converts one v1 event to its channel event, or `undefined` for events that
 * have no channel. `paused` says the run stopped at an interrupt, which its
 * `end` event can't tell from a run that finished.
 */
export function toChannelEvent(
  event: string,
  data: unknown,
  paused = false
): ChannelEvent | undefined {
  const bar = event.indexOf("|");
  const method = bar === -1 ? event : event.slice(0, bar);
  const namespace = bar === -1 ? [] : event.slice(bar + 1).split("|");
  const channel = (
    channelMethod: ChannelEvent["method"],
    channelData: unknown
  ): ChannelEvent => ({
    method: channelMethod,
    params: { namespace, timestamp: Date.now(), data: channelData },
  });
  switch (method) {
    case "values":
    case "updates":
    case "messages":
      return channel(method, data);
    case "custom":
      return channel("custom", { payload: data });
    case "tools": {
      const tool = toToolEvent(data as V1ToolEvent | null);
      return tool && channel("tools", tool);
    }
    case "lifecycle": {
      // v3 runs send bare `lifecycle` events of their own shape.
      if (bar === -1) return undefined;
      const {
        event: status,
        tool_call_id,
        error,
      } = (data ?? {}) as V1Lifecycle;
      return channel("lifecycle", {
        event: status,
        ...(tool_call_id && { cause: { type: "toolCall", tool_call_id } }),
        ...(error && { error: error.message }),
      });
    }
    case "end": {
      const { status } = (data ?? {}) as { status?: string };
      let ended = "failed";
      if (status === "success") ended = paused ? "interrupted" : "completed";
      else if (status === "interrupted" || status === "rollback") {
        ended = "interrupted";
      }
      return channel("lifecycle", { event: ended });
    }
    default:
      return undefined;
  }
}

function toToolEvent(data: V1ToolEvent | null) {
  const tool_call_id = data?.toolCallId;
  switch (data?.event) {
    case "on_tool_start":
      return {
        event: "tool-started",
        tool_call_id,
        tool_name: data.name,
        input: data.input,
      };
    case "on_tool_end":
      return { event: "tool-finished", tool_call_id, output: data.output };
    case "on_tool_error": {
      const { error } = data;
      return {
        event: "tool-error",
        tool_call_id,
        message:
          typeof error === "string"
            ? error
            : String((error as { message?: unknown })?.message ?? error),
      };
    }
    case "on_tool_event":
      return { event: "tool-progress", tool_call_id, data: data.data };
    default:
      return undefined;
  }
}

/** The channel listeners of one engine. */
export class ChannelListeners {
  #listeners = new Set<(event: ChannelEvent) => void>();

  add(listener: (event: ChannelEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: string, data: unknown, paused?: boolean): void {
    if (this.#listeners.size === 0) return;
    const channelEvent = toChannelEvent(event, data, paused);
    if (channelEvent == null) return;
    for (const listener of this.#listeners) {
      // Listeners run inside the stream's event loop, so a throw would end
      // the stream.
      try {
        listener(channelEvent);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

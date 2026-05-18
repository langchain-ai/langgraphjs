import { defineComponent, ref } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolEvent } from "@langchain/langgraph-sdk";

import { useStream } from "../../index.js";
import { getLocationTool } from "../fixtures/browser-fixtures.js";

/**
 * Module-level slot lets tests override the tool's execute function
 * before mounting the component.
 */
type ExecuteFn = Parameters<typeof getLocationTool.implement>[0];
let pendingExecute: ExecuteFn | null = null;
export function setHeadlessToolExecute(fn: ExecuteFn | null): void {
  pendingExecute = fn;
}

export const HeadlessToolStream = defineComponent({
  name: "HeadlessToolStream",
  props: {
    apiUrl: { type: String, default: undefined },
    assistantId: { type: String, default: "headlessToolAgent" },
  },
  setup(props) {
    const toolEvents = ref<ToolEvent[]>([]);

    const tool = getLocationTool.implement(
      pendingExecute ??
        (async () => ({
          latitude: 37.7749,
          longitude: -122.4194,
        })),
    );

    const stream = useStream<{ messages: BaseMessage[] }>({
      assistantId: props.assistantId,
      apiUrl: props.apiUrl,
      tools: [tool],
      onTool: (event: ToolEvent) => {
        toolEvents.value = [...toolEvents.value, event];
      },
    });

    const formatContent = (msg: BaseMessage): string =>
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);

    const errorSuffix = (event: ToolEvent): string => {
      if (event.phase === "error") {
        const err = event.error as { message?: string } | undefined;
        return err?.message ? `:${err.message}` : "";
      }
      return "";
    };

    return () => (
      <div>
        <div data-testid="loading">
          {stream.isLoading.value ? "loading" : "idle"}
        </div>
        <div data-testid="interrupt-count">{stream.interrupts.value.length}</div>

        <div data-testid="tool-events">
          {toolEvents.value.map((event, i) => (
            <div key={i} data-testid={`tool-event-${i}`}>
              {event.phase}:{event.name}
              {errorSuffix(event)}
            </div>
          ))}
        </div>

        <div data-testid="messages">
          {stream.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {formatContent(msg)}
            </div>
          ))}
        </div>

        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({
              messages: [new HumanMessage("Where am I?")],
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
});

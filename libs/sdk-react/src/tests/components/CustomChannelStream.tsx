import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useChannel, useValues } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  customBufferSize?: number;
}

interface StreamState {
  messages: BaseMessage[];
}

export function CustomChannelStream({
  apiUrl,
  assistantId = "custom_channel_graph",
  customBufferSize,
}: Props) {
  const thread = useStream<StreamState>({
    assistantId,
    apiUrl,
  });

  const customEvents = useChannel(
    thread,
    ["custom"],
    undefined,
    customBufferSize == null ? undefined : { bufferSize: customBufferSize },
  );
  const values = useValues<StreamState>(thread);

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>

      <div data-testid="custom-event-count">{customEvents.length}</div>
      <div data-testid="custom-event-types">
        {customEvents.map((ev) => ev.method ?? "").join(",")}
      </div>

      <div data-testid="values-message-count">
        {values?.messages?.length ?? 0}
      </div>

      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Trigger custom writer")],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

import { useEffect, useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  useStream,
  useExtension,
  useChannel,
  useValues,
} from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  extensionName?: string;
  customBufferSize?: number;
}

interface StreamState {
  messages: BaseMessage[];
}

/**
 * Exercises the non-message selector hooks at the root namespace:
 * {@link useExtension} for named custom-channel payloads,
 * {@link useChannel} for the raw event buffer, and {@link useValues}
 * for the latest thread values.
 */
export function ExtensionSelectorsStream({
  apiUrl,
  assistantId = "custom_channel_graph",
  extensionName = "status",
  customBufferSize,
}: Props) {
  const thread = useStream<StreamState>({
    assistantId,
    apiUrl,
  });

  const extension = useExtension<{ label: string; params?: unknown }>(
    thread,
    extensionName,
  );
  const customEvents = useChannel(
    thread,
    ["custom"],
    undefined,
    customBufferSize == null ? undefined : { bufferSize: customBufferSize },
  );
  const values = useValues<StreamState>(thread);
  const [extensionCount, setExtensionCount] = useState(0);

  useEffect(() => {
    if (extension == null) return;
    setExtensionCount((count) => count + 1);
  }, [extension]);

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>

      <div data-testid="extension-label">{extension?.label ?? ""}</div>
      <div data-testid="extension-json">
        {extension == null ? "" : JSON.stringify(extension)}
      </div>
      <div data-testid="extension-count">{extensionCount}</div>
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

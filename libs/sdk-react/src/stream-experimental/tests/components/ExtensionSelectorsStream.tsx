import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  useStreamExperimental,
  useExtension,
  useChannel,
  useValues,
} from "../../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  extensionName?: string;
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
}: Props) {
  const thread = useStreamExperimental<StreamState>({
    assistantId,
    apiUrl,
  });

  const extension = useExtension<{ label: string }>(
    thread,
    extensionName,
  );
  const customEvents = useChannel(thread, ["custom"]);
  const values = useValues<StreamState>(thread);

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>

      <div data-testid="extension-label">{extension?.label ?? ""}</div>
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

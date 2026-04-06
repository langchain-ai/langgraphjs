import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  threadId?: string | null;
  fetchStateHistory?: boolean | { limit: number };
}

export function HistoryMessages({
  apiUrl,
  threadId,
  fetchStateHistory = true,
}: Props) {
  const thread = useStream<{ messages: Record<string, unknown>[] }>({
    assistantId: "agent",
    apiUrl,
    threadId,
    fetchStateHistory,
  });

  const historyMessages = thread.history.flatMap(
    (state) => state.values.messages,
  );

  const allAreBaseMessage =
    historyMessages.length > 0 &&
    historyMessages.every(
      (msg) => typeof (msg as { getType?: unknown }).getType === "function",
    );

  const messageTypes = historyMessages
    .map((msg) => {
      const fn = (msg as { getType?: () => string }).getType;
      return typeof fn === "function" ? fn.call(msg) : "plain";
    })
    .join(",");

  return (
    <div>
      <div data-testid="history-count">{thread.history.length}</div>
      <div data-testid="history-all-base-message">
        {String(allAreBaseMessage)}
      </div>
      <div data-testid="history-message-types">{messageTypes}</div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

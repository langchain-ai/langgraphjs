import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
}

export function Branching({ apiUrl, assistantId = "agent" }: Props) {
  const { submit, messages, getMessagesMetadata, setBranch } = useStream({
    assistantId,
    apiUrl,
    fetchStateHistory: true,
  });

  return (
    <div>
      <div data-testid="messages">
        {messages.map((msg, i) => {
          const metadata = getMessagesMetadata(msg, i);
          const checkpoint =
            metadata?.firstSeenState?.parent_checkpoint ?? undefined;
          const text =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
          const branchOptions = metadata?.branchOptions;
          const branch = metadata?.branch;
          const branchIndex =
            branchOptions && branch ? branchOptions.indexOf(branch) : -1;

          return (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              <div data-testid={`content-${i}`}>{text}</div>

              {branchOptions && branch && (
                <div data-testid={`branch-nav-${i}`}>
                  <button
                    data-testid={`prev-${i}`}
                    onClick={() => {
                      const prevBranch = branchOptions[branchIndex - 1];
                      if (prevBranch) setBranch(prevBranch);
                    }}
                  >
                    Previous
                  </button>
                  <span data-testid={`branch-info-${i}`}>
                    {branchIndex + 1} / {branchOptions.length}
                  </span>
                  <button
                    data-testid={`next-${i}`}
                    onClick={() => {
                      const nextBranch = branchOptions[branchIndex + 1];
                      if (nextBranch) setBranch(nextBranch);
                    }}
                  >
                    Next
                  </button>
                </div>
              )}

              {msg.type === "human" && (
                <button
                  data-testid={`fork-${i}`}
                  onClick={() =>
                    void submit(
                      {
                        messages: [
                          { type: "human", content: `Fork: ${text}` },
                        ],
                      } as any,
                      { checkpoint }
                    )
                  }
                >
                  Fork
                </button>
              )}

              {msg.type === "ai" && (
                <button
                  data-testid={`regenerate-${i}`}
                  onClick={() =>
                    void submit(undefined as any, { checkpoint })
                  }
                >
                  Regenerate
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void submit({
            messages: [{ content: "Hello", type: "human" }],
          } as any)
        }
      >
        Send
      </button>
    </div>
  );
}

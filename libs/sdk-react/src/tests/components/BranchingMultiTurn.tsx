import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
}

export function BranchingMultiTurn({
  apiUrl,
  assistantId = "agent",
}: Props) {
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
            metadata?.forkParentCheckpoint ??
            metadata?.firstSeenState?.parent_checkpoint ??
            undefined;
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
              <div data-testid={`fork-parent-${i}`}>
                {metadata?.forkParentCheckpoint?.checkpoint_id ?? ""}
              </div>

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
                        messages: [{ type: "human", content: `Fork: ${text}` }],
                      },
                      { checkpoint },
                    )
                  }
                >
                  Fork
                </button>
              )}

              {msg.type === "ai" && (
                <button
                  data-testid={`regenerate-${i}`}
                  onClick={() => void submit(undefined, { checkpoint })}
                >
                  Regenerate
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        data-testid="submit-root"
        onClick={() =>
          void submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Send Root
      </button>
      <button
        data-testid="submit-follow-up"
        onClick={() =>
          void submit({
            messages: [{ content: "Follow up", type: "human" }],
          })
        }
      >
        Send Follow Up
      </button>
    </div>
  );
}

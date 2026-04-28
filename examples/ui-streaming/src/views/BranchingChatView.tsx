import { useCallback, useEffect, useMemo, useState } from "react";
import { useMessageMetadata, useMessages, useStream } from "@langchain/react";
import type { BaseMessage } from "@langchain/core/messages";
import { getBranchContext } from "@langchain/langgraph-sdk/ui";

import type { agent as branchingAgentType } from "../agents/branching-chat";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { toBaseMessages } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "branching-chat";

const SUGGESTIONS = [
  "Tell me an interesting fact about space.",
  "What is 15% of 230?",
  "Give me a random history fact.",
];

interface HistoryState {
  checkpoint?: { checkpoint_id?: string };
  parent_checkpoint?: { checkpoint_id?: string };
  values?: { messages?: unknown };
}

interface BranchMetadata {
  parentCheckpointId?: string;
  branch?: string;
  branchOptions?: string[];
}

export function BranchingChatView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryState[]>([]);
  const [branch, setBranch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const stream = useStream<typeof branchingAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const liveMessages = useMessages(stream);
  const eventTrace = useEventTrace(stream);

  const refreshHistory = useCallback(async () => {
    if (!stream.threadId) return;
    try {
      const states = await (
        stream.client.threads as unknown as {
          getHistory: (
            threadId: string,
            options?: { limit?: number }
          ) => Promise<HistoryState[]>;
        }
      ).getHistory(stream.threadId, { limit: 100 });
      setHistory(states);
    } catch {
      setHistory([]);
    }
  }, [stream.client.threads, stream.threadId]);

  useEffect(() => {
    if (!stream.isLoading) {
      void refreshHistory();
    }
  }, [refreshHistory, stream.isLoading]);

  const branchContext = useMemo(
    () => getBranchContext(branch, history as never) as {
      threadHead?: HistoryState;
      branchByCheckpoint: Record<
        string,
        { branch?: string; branchOptions?: string[] }
      >;
    },
    [branch, history]
  );

  const historyMessages = useMemo(
    () => toBaseMessages(branchContext.threadHead?.values?.messages),
    [branchContext.threadHead?.values?.messages]
  );

  const messages =
    historyMessages.length > 0 && !stream.isLoading
      ? historyMessages
      : liveMessages;

  const historyMetadata = useMemo(() => {
    const byMessageId = new Map<string, BranchMetadata>();
    const seen = new Set<string>();
    for (const state of [...history].reverse()) {
      const checkpointId = state.checkpoint?.checkpoint_id;
      const rawMessages = toBaseMessages(state.values?.messages);
      for (const message of rawMessages) {
        const id = message.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const branchData =
          checkpointId == null
            ? undefined
            : branchContext.branchByCheckpoint[checkpointId];
        byMessageId.set(id, {
          parentCheckpointId: state.parent_checkpoint?.checkpoint_id,
          branch: branchData?.branch,
          branchOptions: branchData?.branchOptions,
        });
      }
    }
    return byMessageId;
  }, [branchContext.branchByCheckpoint, history]);

  const handleSubmit = useCallback(
    (content: string) => {
      void stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  const forkFrom = useCallback(
    (checkpointId: string | undefined, content?: string) => {
      if (!checkpointId) return;
      void stream.submit(
        content == null
          ? undefined
          : { messages: [{ content, type: "human" }] },
        { forkFrom: { checkpointId } }
      );
    },
    [stream]
  );

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Branching Chat"
      description={
        <>
          Edit a previous human message or regenerate an assistant response.
          Each action forks from the message's parent checkpoint, then the
          branch switcher lets you compare alternate paths.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            className="suggestion-chip"
            key={suggestion}
            onClick={() => handleSubmit(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div className="playground-grid">
        <section className="conversation-card">
          <div className="panel-card-header">
            <h3>Conversation branches</h3>
            <span className="conversation-status">
              {stream.isLoading ? "Streaming..." : "Idle"}
            </span>
          </div>
          <div className="branching-feed">
            {messages.map((message, index) => (
              <BranchingMessage
                editingId={editingId}
                fallbackMetadata={historyMetadata.get(message.id ?? "")}
                isStreaming={stream.isLoading}
                key={message.id ?? index}
                message={message}
                onCancelEdit={() => setEditingId(null)}
                onEdit={(checkpointId, content) => {
                  setEditingId(null);
                  forkFrom(checkpointId, content);
                }}
                onRegenerate={(checkpointId) => forkFrom(checkpointId)}
                onSelectBranch={setBranch}
                setEditingId={setEditingId}
                stream={stream}
              />
            ))}
          </div>
          <Composer
            disabled={stream.isLoading || editingId != null}
            onSubmit={handleSubmit}
            placeholder="Ask something, then edit or regenerate a prior turn."
          />
        </section>

        <aside className="sidebar-stack">
          <JsonPanel
            title="Branch State"
            value={{
              branch,
              historyStates: history.length,
              threadHead: branchContext.threadHead?.checkpoint,
            }}
          />
          <JsonPanel title="Current Values" value={stream.values} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}

function BranchingMessage({
  editingId,
  fallbackMetadata,
  isStreaming,
  message,
  onCancelEdit,
  onEdit,
  onRegenerate,
  onSelectBranch,
  setEditingId,
  stream,
}: {
  editingId: string | null;
  fallbackMetadata?: BranchMetadata;
  isStreaming: boolean;
  message: BaseMessage;
  onCancelEdit: () => void;
  onEdit: (checkpointId: string | undefined, content: string) => void;
  onRegenerate: (checkpointId: string | undefined) => void;
  onSelectBranch: (branch: string) => void;
  setEditingId: (id: string | null) => void;
  stream: ReturnType<typeof useStream<typeof branchingAgentType>>;
}) {
  const liveMetadata = useMessageMetadata(stream, message.id);
  const metadata = {
    ...fallbackMetadata,
    parentCheckpointId:
      fallbackMetadata?.parentCheckpointId ?? liveMetadata?.parentCheckpointId,
  };
  const isEditing = editingId === message.id;

  if (isEditing) {
    return (
      <form
        className="branch-edit-card"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const content = String(data.get("content") ?? "").trim();
          if (content) onEdit(metadata.parentCheckpointId, content);
        }}
      >
        <textarea
          className="composer-textarea"
          defaultValue={message.text}
          name="content"
          rows={4}
        />
        <div className="branch-actions">
          <button className="secondary-button" onClick={onCancelEdit} type="button">
            Cancel
          </button>
          <button className="primary-button" type="submit">
            Save fork
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="branch-message-shell">
      <div className="branch-toolbar">
        <div className="branch-control-group">
          <BranchSwitcher metadata={metadata} onSelectBranch={onSelectBranch} />
          {message.type === "human" ? (
            <button
              className="secondary-button"
              disabled={isStreaming || !metadata.parentCheckpointId}
              onClick={() => setEditingId(message.id ?? null)}
              type="button"
            >
              Edit
            </button>
          ) : (
            <button
              className="secondary-button"
              disabled={isStreaming || !metadata.parentCheckpointId}
              onClick={() => onRegenerate(metadata.parentCheckpointId)}
              type="button"
            >
              Regenerate
            </button>
          )}
        </div>
      </div>
      <MessageFeed
        getMessageMetadata={() => metadata}
        isStreaming={isStreaming}
        messages={[message]}
      />
    </div>
  );
}

function BranchSwitcher({
  metadata,
  onSelectBranch,
}: {
  metadata: BranchMetadata;
  onSelectBranch: (branch: string) => void;
}) {
  const options = metadata.branchOptions ?? [];
  if (options.length === 0) {
    return (
      <span className="branch-pill">
        {metadata.parentCheckpointId ? "main path" : "checkpoint pending"}
      </span>
    );
  }
  const currentBranch = metadata.branch ?? "";
  const currentIndex = Math.max(0, options.indexOf(currentBranch));
  const total = options.length;
  const previousBranch = options[(currentIndex - 1 + total) % total];
  const nextBranch = options[(currentIndex + 1) % total];

  return (
    <div className="branch-switcher">
      <button
        aria-label="Previous branch"
        className="branch-option"
        disabled={total < 2}
        onClick={() => onSelectBranch(previousBranch)}
        type="button"
      >
        {"<"}
      </button>
      <span className="branch-pill">
        Branch {currentIndex + 1} / {total}
      </span>
      <button
        aria-label="Next branch"
        className="branch-option"
        disabled={total < 2}
        onClick={() => onSelectBranch(nextBranch)}
        type="button"
      >
        {">"}
      </button>
    </div>
  );
}

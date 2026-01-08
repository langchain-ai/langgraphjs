import { useState, useCallback } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  AlertCircle,
  GitBranch,
  Pencil,
  RefreshCw,
  X,
  Check,
} from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";
import type { InferAgentToolCalls } from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageInput } from "../../components/MessageInput";
import { ToolCallCard } from "../../components/ToolCallCard";

import type { agent } from "./agent";
import { BranchSwitcher } from "./components/BranchSwitcher";

const BRANCHING_SUGGESTIONS = [
  "Tell me an interesting fact about science",
  "What's 15% of 230?",
  "Give me a random history fact",
];

/**
 * Helper to check if a message has actual text content.
 */
function hasContent(message: Message): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  if (Array.isArray(message.content)) {
    return message.content.some(
      (c) => c.type === "text" && c.text.trim().length > 0
    );
  }
  return false;
}

/**
 * Extract text content from a message
 */
function getTextContent(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/**
 * Inline edit component for human messages
 */
function EditableMessage({
  content,
  onSave,
  onCancel,
}: {
  content: string;
  onSave: (newContent: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(content);

  return (
    <div className="flex flex-col gap-2 w-full">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full px-3 py-2 bg-neutral-800 border border-neutral-600 rounded-lg text-neutral-100 text-sm resize-none focus:outline-none focus:border-purple-500"
        rows={3}
        autoFocus
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-lg bg-neutral-700 hover:bg-neutral-600 text-neutral-300 transition-colors flex items-center gap-1"
        >
          <X className="w-3 h-3" />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(value)}
          className="px-3 py-1.5 text-xs rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors flex items-center gap-1"
        >
          <Check className="w-3 h-3" />
          Save & Branch
        </button>
      </div>
    </div>
  );
}

export function BranchingChat() {
  const stream = useStream<typeof agent>({
    assistantId: "branching-chat",
    apiUrl: "http://localhost:2024",
    // Enable state history fetching for branching support
    fetchStateHistory: true,
  });

  const { scrollRef, contentRef } = useStickToBottom();
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const hasMessages = stream.messages.length > 0;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  /**
   * Edit a human message - creates a new branch from the parent checkpoint
   */
  const handleEditMessage = useCallback(
    (
      message: Message<InferAgentToolCalls<typeof agent>>,
      newContent: string
    ) => {
      const meta = stream.getMessagesMetadata(message);
      const parentCheckpoint = meta?.firstSeenState?.parent_checkpoint;

      // Submit from the parent checkpoint with the new message content
      stream.submit(
        { messages: [{ content: newContent, type: "human" }] },
        { checkpoint: parentCheckpoint }
      );
      setEditingMessageId(null);
    },
    [stream]
  );

  /**
   * Regenerate an AI response - creates a new branch from the parent checkpoint
   */
  const handleRegenerate = useCallback(
    (message: Message<InferAgentToolCalls<typeof agent>>) => {
      const meta = stream.getMessagesMetadata(message);
      const parentCheckpoint = meta?.firstSeenState?.parent_checkpoint;

      // Submit with undefined to regenerate from the parent checkpoint
      stream.submit(undefined, { checkpoint: parentCheckpoint });
    },
    [stream]
  );

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={GitBranch}
              title="Branching Chat"
              description="Explore alternate conversation paths! Edit any message to branch the conversation, or regenerate AI responses to see different outcomes. Navigate between branches using the switcher."
              suggestions={BRANCHING_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.messages.map((message, idx) => {
                const meta = stream.getMessagesMetadata(message);
                const isEditing = editingMessageId === message.id;

                // For AI messages, check if they have tool calls
                if (message.type === "ai") {
                  const toolCalls = stream.getToolCalls(message);

                  // Render tool calls if present
                  if (toolCalls.length > 0) {
                    return (
                      <div key={message.id} className="flex flex-col gap-3">
                        {toolCalls.map((toolCall) => (
                          <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                        ))}
                        {/* Regenerate button for tool calls */}
                        <div className="flex items-center gap-2">
                          <BranchSwitcher
                            branch={meta?.branch}
                            branchOptions={meta?.branchOptions}
                            onSelect={(branch) => stream.setBranch(branch)}
                          />
                          <button
                            type="button"
                            onClick={() => handleRegenerate(message)}
                            disabled={stream.isLoading}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-neutral-400 hover:text-purple-400 hover:bg-neutral-800/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Regenerate (creates a new branch)"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Regenerate
                          </button>
                        </div>
                      </div>
                    );
                  }

                  // Skip AI messages without content
                  if (!hasContent(message)) {
                    return null;
                  }

                  // Render AI message with regenerate option
                  return (
                    <div key={message.id ?? idx} className="animate-fade-in">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-medium text-neutral-500">
                          Assistant
                        </span>
                        <BranchSwitcher
                          branch={meta?.branch}
                          branchOptions={meta?.branchOptions}
                          onSelect={(branch) => stream.setBranch(branch)}
                        />
                      </div>
                      <div className="text-neutral-100">
                        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
                          {getTextContent(message)}
                        </div>
                      </div>
                      {/* Regenerate button */}
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleRegenerate(message)}
                          disabled={stream.isLoading}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-neutral-400 hover:text-purple-400 hover:bg-neutral-800/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Regenerate response (creates a new branch)"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Regenerate
                        </button>
                      </div>
                    </div>
                  );
                }

                // Human messages with edit option
                if (message.type === "human") {
                  return (
                    <div key={message.id ?? idx} className="animate-fade-in">
                      <div className="flex items-center gap-2 mb-2 justify-end">
                        <BranchSwitcher
                          branch={meta?.branch}
                          branchOptions={meta?.branchOptions}
                          onSelect={(branch) => stream.setBranch(branch)}
                        />
                      </div>
                      <div className="flex justify-end">
                        {isEditing ? (
                          <div className="w-full max-w-[85%] md:max-w-[70%]">
                            <EditableMessage
                              content={getTextContent(message)}
                              onSave={(newContent) =>
                                handleEditMessage(message, newContent)
                              }
                              onCancel={() => setEditingMessageId(null)}
                            />
                          </div>
                        ) : (
                          <div className="group relative">
                            <div className="bg-brand-dark text-brand-light rounded-2xl px-4 py-2.5 max-w-[85%] md:max-w-[70%] w-fit">
                              <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
                                {getTextContent(message)}
                              </div>
                            </div>
                            {/* Edit button */}
                            <button
                              type="button"
                              onClick={() => setEditingMessageId(message.id!)}
                              disabled={stream.isLoading}
                              className="absolute -left-8 top-1/2 -translate-y-1/2 p-1.5 text-neutral-500 hover:text-purple-400 hover:bg-neutral-800/50 rounded opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Edit message (creates a new branch)"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                // Tool messages are handled by ToolCallCard
                if (message.type === "tool") {
                  return null;
                }

                // System messages
                return (
                  <div key={message.id ?? idx} className="animate-fade-in">
                    <div className="text-xs font-medium text-neutral-500 mb-2">
                      System
                    </div>
                    <div className="bg-amber-500/10 border border-amber-500/20 text-amber-200 rounded-lg px-4 py-3">
                      <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
                        {getTextContent(message)}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Show loading indicator when streaming */}
              {stream.isLoading &&
                !stream.messages.some(
                  (m) => m.type === "ai" && hasContent(m)
                ) &&
                stream.toolCalls.length === 0 && <LoadingIndicator />}
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                {stream.error instanceof Error
                  ? stream.error.message
                  : "An error occurred"}
              </span>
            </div>
          </div>
        </div>
      )}

      <MessageInput
        disabled={stream.isLoading || editingMessageId !== null}
        placeholder={
          editingMessageId
            ? "Finish editing the message first..."
            : "Ask me anything..."
        }
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "branching-chat",
  title: "Branching Chat",
  description:
    "Explore alternate conversation paths by editing messages or regenerating responses",
  category: "advanced",
  icon: "graph",
  ready: true,
  component: BranchingChat,
});

export default BranchingChat;

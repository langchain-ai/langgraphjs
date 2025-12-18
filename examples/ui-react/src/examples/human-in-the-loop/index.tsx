import { useRef, useEffect, useState, useCallback } from "react";
import { AlertCircle, UserCheck } from "lucide-react";
import {
  useStream,
  type ToolCallWithResult,
} from "@langchain/langgraph-sdk/react";
import type { UIMessage } from "@langchain/langgraph-sdk";
import type { HITLRequest, HITLResponse } from "langchain";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";

import type { agent } from "./agent";
import { ToolCallCard } from "./components/ToolCallCard";
import type { AgentToolCalls } from "./types";
import {
  PendingApprovalCard,
  DEFAULT_REJECT_REASON,
} from "./components/PendingApprovalCard";

const HITL_SUGGESTIONS = [
  "Send an email to john@example.com",
  "Delete the file test.txt",
  "Read the contents of config.json",
];

/**
 * Helper to check if a message has actual text content.
 */
function hasContent(message: UIMessage): boolean {
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

export function HumanInTheLoop() {
  const stream = useStream<typeof agent, { InterruptType: HITLRequest }>({
    assistantId: "human-in-the-loop",
    apiUrl: "http://localhost:2024",
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  /**
   * Auto-scroll to bottom when new messages arrive
   */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stream.uiMessages, stream.isLoading, stream.interrupt]);

  /**
   * Type assertion needed because the generic inference doesn't properly propagate
   */
  const hitlRequest = stream.interrupt?.value as HITLRequest | undefined;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  /**
   * Handle approval for a specific action
   */
  const handleApprove = async (index: number) => {
    if (!hitlRequest) return;
    setIsProcessing(true);
    try {
      const decisions: HITLResponse["decisions"] =
        hitlRequest.actionRequests.map((_, i) => {
          if (i === index) {
            return { type: "approve" as const };
          }
          /**
           * For other actions, also approve them
           */
          return { type: "approve" as const };
        });

      await stream.submit(null, {
        command: {
          resume: { decisions } as HITLResponse,
        },
      });
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Handle rejection for a specific action
   */
  const handleReject = async (index: number, reason: string) => {
    if (!hitlRequest) return;
    setIsProcessing(true);
    try {
      const decisions: HITLResponse["decisions"] =
        hitlRequest.actionRequests.map((_, i) => {
          if (i === index) {
            return {
              type: "reject" as const,
              message: reason || DEFAULT_REJECT_REASON,
            };
          }
          /**
           * For other actions, also reject them to be safe
           */
          return {
            type: "reject" as const,
            message: "Rejected along with other actions",
          };
        });

      await stream.submit(null, {
        command: {
          resume: { decisions } as HITLResponse,
        },
      });
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Handle edit for a specific action
   */
  const handleEdit = async (
    index: number,
    editedArgs: Record<string, unknown>
  ) => {
    if (!hitlRequest) return;
    setIsProcessing(true);
    try {
      const originalAction = hitlRequest.actionRequests[index];
      const decisions: HITLResponse["decisions"] =
        hitlRequest.actionRequests.map((_, i) => {
          if (i === index) {
            return {
              type: "edit" as const,
              editedAction: {
                name: originalAction.name,
                args: editedArgs,
              },
            };
          }
          /**
           * For other actions, approve them
           */
          return { type: "approve" as const };
        });

      await stream.submit(null, {
        command: {
          resume: { decisions } as HITLResponse,
        },
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const hasMessages = stream.uiMessages.length > 0;
  return (
    <div className="h-full flex flex-col">
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages && !stream.interrupt ? (
            <EmptyState
              icon={UserCheck}
              title="Human in the Loop"
              description="An agent that requires your approval for sensitive actions. Try sending an email, deleting a file, or reading file contents."
              suggestions={HITL_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.uiMessages.map((message, idx) => {
                /**
                 * For AI messages, check if they have tool calls
                 */
                if (message.type === "ai") {
                  const toolCalls = stream.getToolCalls(message);

                  /**
                   * Render tool calls if present
                   */
                  if (toolCalls.length > 0) {
                    return (
                      <div key={message.id} className="flex flex-col gap-3">
                        {toolCalls.map((toolCall) => (
                          <ToolCallCard
                            key={toolCall.id}
                            toolCall={
                              toolCall as ToolCallWithResult<AgentToolCalls>
                            }
                          />
                        ))}
                      </div>
                    );
                  }

                  /**
                   * Skip AI messages without content
                   */
                  if (!hasContent(message)) {
                    return null;
                  }
                }

                return (
                  <MessageBubble key={message.id ?? idx} message={message} />
                );
              })}

              {/* Show interrupt UI when awaiting approval */}
              {hitlRequest && hitlRequest.actionRequests.length > 0 && (
                <div className="flex flex-col gap-4">
                  {hitlRequest.actionRequests.map((actionRequest, idx) => (
                    <PendingApprovalCard
                      key={idx}
                      actionRequest={actionRequest}
                      reviewConfig={hitlRequest.reviewConfigs[idx]}
                      onApprove={() => handleApprove(idx)}
                      onReject={(reason) => handleReject(idx, reason)}
                      onEdit={(editedArgs) => handleEdit(idx, editedArgs)}
                      isProcessing={isProcessing}
                    />
                  ))}
                </div>
              )}

              {/* Show loading indicator when streaming and no content yet */}
              {stream.isLoading &&
                !stream.interrupt &&
                !stream.uiMessages.some(hasContent) &&
                stream.toolCalls.length === 0 && <LoadingIndicator />}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
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
        disabled={stream.isLoading || isProcessing || !!stream.interrupt}
        placeholder={
          stream.interrupt
            ? "Please approve or reject the pending action..."
            : "Ask me to send an email or delete a file..."
        }
        onSubmit={handleSubmit}
      />
    </div>
  );
}

/**
 * Register this example
 */
registerExample({
  id: "human-in-the-loop",
  title: "Human in the Loop",
  description:
    "ReAct agent with interrupts for approving, editing, or rejecting tool calls",
  category: "agents",
  icon: "chat",
  ready: true,
  component: HumanInTheLoop,
});

export default HumanInTheLoop;

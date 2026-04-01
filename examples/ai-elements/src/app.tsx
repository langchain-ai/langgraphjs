import { AIMessage, HumanMessage } from "langchain";
import { useStream } from "@langchain/react";
import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { MessageList } from "./components/message-list";
import { SuggestionsScreen } from "./components/suggestions-screen";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./components/ai-elements/prompt-input";
import { Button } from "./components/ui/button";
import { LANGGRAPH_API_URL, LANGGRAPH_ASSISTANT_ID } from "./lib/stream";
import { useThreadIdParam } from "./lib/thread-id";
import type { agent } from "../agent"

export function App() {
  const [threadId, onThreadId] = useThreadIdParam();
  const [inputText, setInputText] = useState("");

  const stream = useStream<typeof agent>({
    apiUrl: LANGGRAPH_API_URL,
    assistantId: LANGGRAPH_ASSISTANT_ID,
    onThreadId,
    threadId,
  });

  const hasMessages = stream.messages.length > 0;

  const handleSubmit = useCallback(
    (message: { text: string }) => {
      if (!message.text.trim()) return;
      setInputText("");
      stream.submit({ messages: [new HumanMessage(message.text)] });
    },
    [stream],
  );

  const handleSuggestionSelect = useCallback(
    (prompt: string) => {
      stream.submit({ messages: [new HumanMessage(prompt)] });
    },
    [stream],
  );

  const handleNewChat = useCallback(() => {
    onThreadId(null);
  }, [onThreadId]);

  const handleCopyLastMessage = useCallback(() => {
    const lastAi = [...stream.messages].reverse().find(AIMessage.isInstance);
    if (!lastAi) return;
    const content = lastAi.content;
    const text =
      typeof content === "string" ? content : JSON.stringify(content);
    navigator.clipboard.writeText(text).catch(() => undefined);
  }, [stream.messages]);

  const chatStatus = stream.isLoading ? "streaming" : "ready";

  return (
    <div className="flex flex-col h-dvh bg-background text-foreground">
      {hasMessages && (
        <header className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium">AI Elements Demo</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleNewChat}
            className="gap-1.5"
          >
            <PlusIcon className="size-4" />
            New Chat
          </Button>
        </header>
      )}

      {!hasMessages ? (
        <SuggestionsScreen onSelect={handleSuggestionSelect} />
      ) : (
        <MessageList
          stream={stream}
          onCopyLastMessage={handleCopyLastMessage}
        />
      )}

      <div className="shrink-0 p-4 border-t">
        <PromptInput
          onSubmit={handleSubmit}
          className="w-full max-w-2xl mx-auto"
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={inputText}
              placeholder="Ask me something..."
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInputText(e.target.value)}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputSubmit
              status={chatStatus}
              disabled={!inputText.trim() && !stream.isLoading}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

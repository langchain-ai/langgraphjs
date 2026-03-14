"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  ActionBarPrimitive,
  AuiIf,
  AttachmentPrimitive,
  ChainOfThoughtPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardIcon,
  Cross2Icon,
  MixerHorizontalIcon,
  PlusIcon,
  StopIcon,
} from "@radix-ui/react-icons";
import { AlertCircle, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { useShallow } from "zustand/shallow";

import { MarkdownText } from "./markdown-text";

const SUGGESTIONS = [
  "Explain the difference between LangGraph and a basic agent loop in simple terms",
  "Compare vector databases for a medium-size RAG system and recommend one",
  "Draft a concise launch announcement for a new AI developer tool",
];

export function Claude({
  error,
  isLoading,
  onCancel,
  onSuggestionClick,
}: {
  error: unknown;
  isLoading: boolean;
  onCancel: () => void;
  onSuggestionClick: (prompt: string) => void;
}) {
  return (
    <div className="flex h-dvh flex-col bg-[#2b2a27]">
      <ThreadPrimitive.Root className="flex h-full flex-col items-stretch bg-[#F5F5F0] p-4 pt-10 font-serif text-[#1a1a18] dark:bg-[#2b2a27] dark:text-[#eee]">
        <ThreadPrimitive.Viewport className="flex grow flex-col overflow-y-auto">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-2 pb-12">
              <div className="text-center">
                <div className="text-xs uppercase tracking-[0.24em] text-[#9a9893]">
                  Assistant-UI x LangChain React
                </div>
                <h1 className="mt-4 text-4xl text-[#1a1a18] dark:text-[#f1efe8]">
                  Claude-style general agent
                </h1>
                <p className="mx-auto mt-3 max-w-2xl text-base leading-7 text-[#6b6a68] dark:text-[#b8b5a9]">
                  This example uses assistant-ui primitives for the chat surface
                  and `@langchain/react` for basic streamed agent responses.
                </p>
              </div>

              <div className="mt-8 grid gap-3">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="rounded-2xl border border-[#00000015] bg-white px-4 py-3 text-left text-sm text-[#1a1a18] transition hover:bg-[#f8f7f3] dark:border-[#6c6a6040] dark:bg-[#1f1e1b] dark:text-[#f1efe8] dark:hover:bg-[#252421]"
                    onClick={() => onSuggestionClick(suggestion)}
                    type="button"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </AuiIf>

          <ThreadPrimitive.Messages
            components={{
              Message: () => <ChatMessage />,
            }}
          />

          {isLoading && (
            <div className="mx-auto mt-4 flex w-full max-w-3xl items-center gap-3 px-2 text-sm text-[#8a8985] dark:text-[#b8b5a9]">
              <Sparkles className="h-4 w-4" />
              <span className="shimmer shimmer-invert shimmer-duration-1500 shimmer-repeat-delay-0">
                Thinking...
              </span>
            </div>
          )}

          <div aria-hidden="true" className="h-4" />
        </ThreadPrimitive.Viewport>

        {error ? (
          <div className="mx-auto mb-3 w-full max-w-3xl rounded-xl border border-[#d97c66]/30 bg-[#d97c66]/10 px-4 py-3 text-sm text-[#f3c3b7]">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                {error instanceof Error
                  ? error.message
                  : "An error occurred. Make sure OPENAI_API_KEY is set."}
              </span>
            </div>
          </div>
        ) : null}

        <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl flex-col rounded-2xl border border-transparent bg-white p-0.5 shadow-[0_0.25rem_1.25rem_rgba(0,0,0,0.035),0_0_0_0.5px_rgba(0,0,0,0.08)] transition-shadow duration-200 focus-within:shadow-[0_0.25rem_1.25rem_rgba(0,0,0,0.075),0_0_0_0.5px_rgba(0,0,0,0.15)] hover:shadow-[0_0.25rem_1.25rem_rgba(0,0,0,0.05),0_0_0_0.5px_rgba(0,0,0,0.12)] dark:bg-[#1f1e1b] dark:shadow-[0_0.25rem_1.25rem_rgba(0,0,0,0.4),0_0_0_0.5px_rgba(108,106,96,0.15)] dark:hover:shadow-[0_0.25rem_1.25rem_rgba(0,0,0,0.4),0_0_0_0.5px_rgba(108,106,96,0.3)] dark:focus-within:shadow-[0_0.25rem_1.25rem_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(108,106,96,0.3)]">
          <div className="m-3.5 flex flex-col gap-3.5">
            <div className="relative">
              <div className="max-h-96 w-full overflow-y-auto">
                <ComposerPrimitive.Input
                  className="block min-h-6 w-full resize-none bg-transparent text-[#1a1a18] outline-none placeholder:text-[#9a9893] dark:text-[#eee] dark:placeholder:text-[#9a9893]"
                  placeholder="Ask anything..."
                />
              </div>
            </div>

            <div className="flex w-full items-center gap-2">
              <div className="relative flex min-w-0 flex-1 shrink items-center gap-2">
                <ComposerPrimitive.AddAttachment className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-lg border border-[#00000015] bg-transparent px-1.5 text-[#6b6a68] transition-all hover:bg-[#f5f5f0] hover:text-[#1a1a18] active:scale-[0.98] dark:border-[#6c6a6040] dark:text-[#9a9893] dark:hover:bg-[#393937] dark:hover:text-[#eee]">
                  <PlusIcon height={16} width={16} />
                </ComposerPrimitive.AddAttachment>

                <button
                  aria-label="Open tools menu"
                  className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-lg border border-[#00000015] bg-transparent px-1.5 text-[#6b6a68] transition-all hover:bg-[#f5f5f0] hover:text-[#1a1a18] active:scale-[0.98] dark:border-[#6c6a6040] dark:text-[#9a9893] dark:hover:bg-[#393937] dark:hover:text-[#eee]"
                  type="button"
                >
                  <MixerHorizontalIcon height={16} width={16} />
                </button>
              </div>

              <button
                className="flex h-8 min-w-16 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 pl-2.5 pr-2 text-xs text-[#1a1a18] transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-[#f5f5f0] active:scale-[0.985] dark:text-[#eee] dark:hover:bg-[#393937]"
                type="button"
              >
                <span className="font-serif text-[14px]">
                  Sonnet 4.6
                  <span className="opacity-50 pl-2">Extended</span>
                </span>
                <ChevronDownIcon
                  className="opacity-75"
                  height={20}
                  width={20}
                />
              </button>

              {!isLoading && (
                <ComposerPrimitive.Send className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#ae5630] transition-colors hover:bg-[#c4633a] active:scale-95 disabled:pointer-events-none disabled:opacity-50 dark:bg-[#ae5630] dark:hover:bg-[#c4633a]">
                  <ArrowUpIcon className="text-white" height={16} width={16} />
                </ComposerPrimitive.Send>
              )}

              {isLoading && (
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#5f5b53] transition-colors hover:bg-[#716c63] active:scale-95"
                  onClick={onCancel}
                  type="button"
                >
                  <StopIcon className="text-white" height={14} width={14} />
                </button>
              )}
            </div>
          </div>

          <AuiIf condition={(s) => s.composer.attachments.length > 0}>
            <div className="overflow-hidden rounded-b-2xl">
              <div className="overflow-x-auto rounded-b-2xl border-t border-[#00000015] bg-[#f5f5f0] p-3.5 dark:border-[#6c6a6040] dark:bg-[#393937]">
                <div className="flex flex-row gap-3">
                  <ComposerPrimitive.Attachments
                    components={{ Attachment: ClaudeAttachment }}
                  />
                </div>
              </div>
            </div>
          </AuiIf>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </div>
  );
}

const ChatMessage = () => {
  const hasText = useAuiState((state) =>
    state.message.content.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    ),
  );
  const hasRenderableContent = useAuiState((state) =>
    state.message.content.some((part) => {
      if (part.type === "text") return part.text.trim().length > 0;
      return (
        part.type === "reasoning" ||
        part.type === "tool-call" ||
        part.type === "image"
      );
    }),
  );

  return (
    <MessagePrimitive.Root className="group relative mx-auto my-1 block w-full max-w-3xl">
      <AuiIf condition={(state) => state.message.role === "user"}>
        <div className="group/user relative inline-flex max-w-[75ch] flex-col gap-2 rounded-xl bg-[#DDD9CE] py-2.5 pl-2.5 pr-6 text-[#1a1a18] transition-all dark:bg-[#393937] dark:text-[#eee]">
          <div className="relative flex flex-row gap-2">
            <div className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-[#1a1a18] text-[12px] font-bold text-white dark:bg-[#eee] dark:text-[#2b2a27]">
              U
            </div>
            <div className="flex-1">
              <div className="relative grid grid-cols-1 gap-2 py-0.5">
                <div className="whitespace-pre-wrap">
                  <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </AuiIf>

      <AuiIf condition={(state) => state.message.role === "assistant"}>
        <div className="relative mb-12 font-serif">
          <div className="relative leading-[1.65rem]">
            <div className="grid grid-cols-1 gap-2.5">
              <div className="whitespace-normal px-2 pr-8 font-serif text-[#1a1a18] dark:text-[#eee]">
                {hasRenderableContent && (
                  <MessagePrimitive.Parts
                    components={{
                      ChainOfThought: ClaudeChainOfThought,
                      Text: MarkdownText,
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          {hasText && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0">
              <ActionBarPrimitive.Root
                autohide="not-last"
                className="pointer-events-auto flex w-full translate-y-full flex-col items-end px-2 pt-2 transition"
              >
                <div className="flex items-center text-[#6b6a68] dark:text-[#9a9893]">
                  <ActionBarPrimitive.Copy className="flex h-8 w-8 items-center justify-center rounded-md transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-transparent active:scale-95">
                    <ClipboardIcon height={20} width={20} />
                  </ActionBarPrimitive.Copy>
                  <ActionBarPrimitive.FeedbackPositive className="flex h-8 w-8 items-center justify-center rounded-md transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-transparent active:scale-95">
                    <ThumbsUp height={16} width={16} />
                  </ActionBarPrimitive.FeedbackPositive>
                  <ActionBarPrimitive.FeedbackNegative className="flex h-8 w-8 items-center justify-center rounded-md transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-transparent active:scale-95">
                    <ThumbsDown height={16} width={16} />
                  </ActionBarPrimitive.FeedbackNegative>
                </div>
                <AuiIf condition={(state) => state.message.isLast}>
                  <p className="mt-2 w-full text-right text-[0.65rem] leading-[0.85rem] text-[#8a8985] opacity-90 dark:text-[#b8b5a9] sm:text-[0.75rem]">
                    Claude-style UI demo. Verify important details before
                    relying on them.
                  </p>
                </AuiIf>
              </ActionBarPrimitive.Root>
            </div>
          )}
        </div>
      </AuiIf>
    </MessagePrimitive.Root>
  );
};

const ClaudeReasoning: ReasoningMessagePartComponent = ({ text }) => {
  return (
    <div className="whitespace-pre-wrap text-sm leading-6 text-[#6b6a68] italic dark:text-[#b8b5a9]">
      {text}
    </div>
  );
};

function formatToolValue(value: unknown) {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const ClaudeToolCall: ToolCallMessagePartComponent = ({
  argsText,
  isError,
  result,
  status,
  toolName,
}) => {
  const statusLabel =
    status.type === "running"
      ? "Running"
      : isError
        ? "Error"
        : result !== undefined
          ? "Completed"
          : "Pending";

  return (
    <div className="rounded-2xl border border-[#00000012] bg-white/80 shadow-sm dark:border-[#6c6a6040] dark:bg-[#1f1e1b]">
      <div className="flex items-center justify-between gap-3 border-b border-[#00000010] px-4 py-2.5 dark:border-[#6c6a6030]">
        <div className="flex items-center gap-2 text-sm font-medium text-[#1a1a18] dark:text-[#f1efe8]">
          <MixerHorizontalIcon height={14} width={14} />
          <span>{toolName}</span>
        </div>
        <span className="text-[11px] uppercase tracking-[0.18em] text-[#8a8985] dark:text-[#9a9893]">
          {statusLabel}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-[#8a8985] dark:text-[#9a9893]">
            Arguments
          </div>
          <pre className="overflow-x-auto rounded-xl bg-[#f8f7f3] p-3 text-xs leading-5 text-[#4e4c48] dark:bg-[#2b2a27] dark:text-[#d8d5cb]">
            {argsText}
          </pre>
        </div>

        {result !== undefined && (
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-[#8a8985] dark:text-[#9a9893]">
              Result
            </div>
            <pre className="overflow-x-auto rounded-xl bg-[#f8f7f3] p-3 text-xs leading-5 text-[#4e4c48] dark:bg-[#2b2a27] dark:text-[#d8d5cb]">
              {formatToolValue(result)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

const ClaudeChainOfThought: FC = () => {
  const aui = useAui();
  const collapsed = useAuiState((state) => state.chainOfThought.collapsed);
  const [isUsingDefaultOpenState, setIsUsingDefaultOpenState] = useState(true);
  const isExpanded = isUsingDefaultOpenState ? true : !collapsed;

  const onToggle = useCallback(() => {
    if (isUsingDefaultOpenState) {
      setIsUsingDefaultOpenState(false);
      return;
    }

    aui.chainOfThought().setCollapsed(!collapsed);
  }, [aui, collapsed, isUsingDefaultOpenState]);

  return (
    <ChainOfThoughtPrimitive.Root className="mb-4 overflow-hidden rounded-2xl border border-[#00000012] bg-[#ede9dc]/60 dark:border-[#6c6a6040] dark:bg-[#242320]">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-[#5f5b53] transition hover:bg-[#e7e1d1]/70 dark:text-[#b8b5a9] dark:hover:bg-[#2b2a27]"
        onClick={onToggle}
        type="button"
      >
        {isExpanded ? (
          <ChevronDownIcon className="shrink-0" height={16} width={16} />
        ) : (
          <ChevronRightIcon className="shrink-0" height={16} width={16} />
        )}
        <Sparkles className="h-4 w-4 shrink-0" />
        <span className="font-medium">Thinking</span>
      </button>

      {isExpanded && (
        <div className="border-t border-[#00000010] px-4 py-3 dark:border-[#6c6a6030]">
          <ChainOfThoughtPrimitive.Parts
            components={{
              Layout: ({ children }) => (
                <div className="mb-3 last:mb-0">{children}</div>
              ),
              Reasoning: ClaudeReasoning,
              tools: {
                Fallback: ClaudeToolCall,
              },
            }}
          />
        </div>
      )}
    </ChainOfThoughtPrimitive.Root>
  );
};

const useFileSrc = (file: File | undefined) => {
  const src = useMemo(
    () => (file ? URL.createObjectURL(file) : undefined),
    [file],
  );

  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );

  return src;
};

const useAttachmentSrc = () => {
  const { file, src } = useAuiState(
    useShallow((state): { file?: File; src?: string } => {
      if (state.attachment.type !== "image") return {};
      if (state.attachment.file) return { file: state.attachment.file };

      const content = state.attachment.content?.find(
        (part) => part.type === "image",
      );
      if (!content || !("image" in content)) return {};

      return { src: content.image };
    }),
  );

  return useFileSrc(file) ?? src;
};

const ClaudeAttachment: FC = () => {
  const isImage = useAuiState((state) => state.attachment.type === "image");
  const src = useAttachmentSrc();

  return (
    <AttachmentPrimitive.Root className="group/thumbnail relative">
      <div
        className="overflow-hidden rounded-lg border border-[#00000020] shadow-sm hover:border-[#00000040] hover:shadow-md dark:border-[#6c6a6040] dark:hover:border-[#6c6a6080]"
        style={{
          height: "120px",
          minHeight: "120px",
          minWidth: "120px",
          width: "120px",
        }}
      >
        <button
          className="relative bg-white dark:bg-[#2b2a27]"
          style={{ height: "120px", width: "120px" }}
          type="button"
        >
          {isImage && src ? (
            <img
              alt="Attachment"
              className="h-full w-full object-cover opacity-100 transition duration-400"
              src={src}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[#6b6a68] dark:text-[#9a9893]">
              <AttachmentPrimitive.unstable_Thumb className="text-xs" />
            </div>
          )}
        </button>
      </div>

      <AttachmentPrimitive.Remove
        aria-label="Remove attachment"
        className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-[#00000020] bg-white/90 text-[#6b6a68] opacity-0 backdrop-blur-sm transition-all hover:bg-white hover:text-[#1a1a18] group-focus-within/thumbnail:opacity-100 group-hover/thumbnail:opacity-100 dark:border-[#6c6a6040] dark:bg-[#1f1e1b]/90 dark:text-[#9a9893] dark:hover:bg-[#1f1e1b] dark:hover:text-[#eee]"
      >
        <Cross2Icon height={12} width={12} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

import { useEffect } from "react";
import { inject } from "vitest";
import type { DeepAgent } from "deepagents";

import type { Message } from "../../types.messages.js";
import type { SubmitOptions, UseStreamOptions } from "../../ui/types.js";
import { useStream } from "../index.js";

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string;
  }
}

type State = { messages: Message[] };

const apiUrl = inject("serverUrl");

const text = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);

export function Stream({
  options,
  submitOptions,
  onRender,
}: {
  options?: Partial<UseStreamOptions<State>>;
  submitOptions?: SubmitOptions<State>;
  onRender?: (messages: Message[]) => void;
}) {
  const thread = useStream<State>({
    apiUrl,
    assistantId: "agent",
    ...options,
  });
  const { messages, interrupt } = thread;

  useEffect(() => {
    onRender?.(messages);
  }, [onRender, messages]);

  return (
    <div>
      <div data-testid="messages">
        {messages.map((message, i) => (
          <div
            key={message.id ?? i}
            data-testid={`message-${i}`}
            data-node={String(
              thread.getMessagesMetadata(message, i)?.streamMetadata
                ?.langgraph_node ?? ""
            )}
          >
            {text(message)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      {thread.error ? (
        <div data-testid="error">{String(thread.error)}</div>
      ) : null}
      {interrupt ? (
        <div data-testid="interrupt">
          {interrupt.when ?? JSON.stringify(interrupt.value)}
        </div>
      ) : null}
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit(
            { messages: [{ type: "human", content: "Hello" }] },
            submitOptions
          )
        }
      >
        Send
      </button>
      <button
        data-testid="resume"
        onClick={() =>
          void thread.submit(null, { command: { resume: "Resuming" } })
        }
      >
        Resume
      </button>
      <button data-testid="stop" onClick={() => void thread.stop()}>
        Stop
      </button>
    </div>
  );
}

export function Branching() {
  const { submit, messages, getMessagesMetadata, setBranch } =
    useStream<State>({ apiUrl, assistantId: "agent", fetchStateHistory: true });

  return (
    <div>
      {messages.map((message, i) => {
        const metadata = getMessagesMetadata(message, i);
        const checkpoint = metadata?.firstSeenState?.parent_checkpoint;
        const branch = metadata?.branch;
        const options = metadata?.branchOptions;
        const index = options && branch ? options.indexOf(branch) : -1;

        return (
          <div key={message.id ?? i}>
            <div data-testid={`content-${i}`}>{text(message)}</div>
            {options && branch ? (
              <div data-testid={`branch-nav-${i}`}>
                <button
                  data-testid={`prev-${i}`}
                  onClick={() => index > 0 && setBranch(options[index - 1])}
                >
                  Previous
                </button>
                <span data-testid={`branch-info-${i}`}>
                  {index + 1} / {options.length}
                </span>
              </div>
            ) : null}
            {message.type === "human" ? (
              <button
                data-testid={`fork-${i}`}
                onClick={() =>
                  void submit(
                    {
                      messages: [
                        { type: "human", content: `Fork: ${text(message)}` },
                      ],
                    },
                    { checkpoint }
                  )
                }
              >
                Fork
              </button>
            ) : (
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
      <button
        data-testid="submit"
        onClick={() =>
          void submit({ messages: [{ type: "human", content: "Hello" }] })
        }
      >
        Send
      </button>
    </div>
  );
}

const describeMessage = (message: Message) => {
  if (message.type === "ai" && message.tool_calls?.length) {
    return message.tool_calls
      .map((call) => `tool_call:${call.name}:${JSON.stringify(call.args)}`)
      .join(",");
  }
  return message.type === "tool"
    ? `tool_result:${text(message)}`
    : text(message);
};

export function DeepAgentStream() {
  const thread = useStream<DeepAgent>({
    apiUrl,
    assistantId: "deepAgent",
    filterSubagentMessages: true,
  });

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="messages">
        {thread.messages.map((message, i) => (
          <div key={message.id ?? i}>{describeMessage(message)}</div>
        ))}
      </div>
      <div data-testid="subagent-count">{thread.subagents.size}</div>
      {[...thread.subagents.values()].map((subagent) => {
        const type = subagent.toolCall?.args?.subagent_type ?? "unknown";
        return (
          <div key={subagent.id} data-testid={`subagent-${type}`}>
            <div data-testid={`subagent-${type}-status`}>{subagent.status}</div>
            <div data-testid={`subagent-${type}-task-description`}>
              {subagent.toolCall?.args?.description}
            </div>
            <div data-testid={`subagent-${type}-result`}>{subagent.result}</div>
            <div data-testid={`subagent-${type}-messages-count`}>
              {subagent.messages.length}
            </div>
            <div data-testid={`subagent-${type}-tool-calls`}>
              {subagent.toolCalls
                .map((call) => `${call.call.name}:${call.state}`)
                .join(",")}
            </div>
          </div>
        );
      })}
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit(
            { messages: [{ type: "human", content: "Run analysis" }] },
            { streamSubgraphs: true }
          )
        }
      >
        Send
      </button>
    </div>
  );
}

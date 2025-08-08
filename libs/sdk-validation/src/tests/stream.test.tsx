import "@testing-library/jest-dom/vitest";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { http } from "msw";
import { useStream } from "@langchain/langgraph-sdk/react";
import { Client, type Message } from "@langchain/langgraph-sdk";

import { StateGraph, MessagesAnnotation, START } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { AIMessage } from "@langchain/core/messages";
import { createEmbedServer } from "@langchain/langgraph-api/experimental/embed";
import { randomUUID } from "node:crypto";
import { useState } from "react";

const threads = (() => {
  const THREADS: Record<
    string,
    { thread_id: string; metadata: Record<string, unknown> }
  > = {};

  return {
    get: async (id: string) => THREADS[id],
    put: async (
      threadId: string,
      { metadata }: { metadata?: Record<string, unknown> }
    ) => {
      THREADS[threadId] = { thread_id: threadId, metadata: metadata ?? {} };
    },
    delete: async (threadId: string) => {
      delete THREADS[threadId];
    },
  };
})();

const checkpointer = new MemorySaver();

const model = new FakeStreamingChatModel({ responses: [new AIMessage("Hey")] });
const agent = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state: { messages: Message[] }) => {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  })
  .addEdge(START, "agent")
  .compile();

const parentAgent = new StateGraph(MessagesAnnotation)
  .addNode("agent", agent, { subgraphs: [agent] })
  .addEdge(START, "agent")
  .compile();

const app = createEmbedServer({
  graph: { agent, parentAgent },
  checkpointer,
  threads,
});
const server = setupServer(http.all("*", (ctx) => app.fetch(ctx.request)));

function TestChatComponent() {
  const { messages, isLoading, error, submit, stop } = useStream({
    assistantId: "agent",
    apiKey: "test-api-key",
  });

  return (
    <div>
      <div data-testid="messages">
        {messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {isLoading ? "Loading..." : "Not loading"}
      </div>
      {error ? <div data-testid="error">{String(error)}</div> : null}
      <button
        data-testid="submit"
        onClick={() =>
          submit({ messages: [{ content: "Hello", type: "human" }] })
        }
      >
        Send
      </button>
      <button data-testid="stop" onClick={stop}>
        Stop
      </button>
    </div>
  );
}

describe("useStream", () => {
  beforeEach(() => server.listen());

  afterEach(() => {
    server.resetHandlers();
    server.close();
    vi.clearAllMocks();
  });

  it("renders initial state correctly", () => {
    render(<TestChatComponent />);

    expect(screen.getByTestId("loading")).toHaveTextContent("Not loading");
    expect(screen.getByTestId("messages")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("error")).not.toBeInTheDocument();
  });

  it("handles message submission and streaming", async () => {
    const user = userEvent.setup();

    render(<TestChatComponent />);

    // Check loading state
    await user.click(screen.getByTestId("submit"));
    expect(screen.getByTestId("loading")).toHaveTextContent("Loading...");

    // Wait for messages to appear
    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1")).toHaveTextContent("Hey");
    });

    // Check final state
    expect(screen.getByTestId("loading")).toHaveTextContent("Not loading");
  });

  it("handles stop functionality", async () => {
    const user = userEvent.setup();
    render(<TestChatComponent />);

    // Start streaming and stop immediately
    await user.click(screen.getByTestId("submit"));
    await user.click(screen.getByTestId("stop"));

    // Check loading state is reset
    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("Not loading");
    });
  });

  it("displays initial values immediately and clears them when submitting", async () => {
    const user = userEvent.setup();

    function TestCachedComponent() {
      const { messages, values, submit } = useStream<{
        messages: Message[];
      }>({
        assistantId: "agent",
        apiKey: "test-api-key",
        initialValues: {
          messages: [
            { id: "cached-1", type: "human", content: "Cached user message" },
            { id: "cached-2", type: "ai", content: "Cached AI response" },
          ],
        },
      });

      return (
        <div>
          <div data-testid="messages">
            {messages.map((msg, i) => (
              <div
                key={msg.id ?? i}
                data-testid={
                  msg.id?.includes("cached")
                    ? `message-cached-${i}`
                    : `message-${i}`
                }
              >
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <div data-testid="values">{JSON.stringify(values)}</div>
          <button
            data-testid="submit"
            onClick={() =>
              submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Submit
          </button>
        </div>
      );
    }

    render(<TestCachedComponent />);

    // Should immediately show cached messages
    expect(screen.getByTestId("message-cached-0")).toHaveTextContent(
      "Cached user message"
    );
    expect(screen.getByTestId("message-cached-1")).toHaveTextContent(
      "Cached AI response"
    );

    // Values should include initial values
    expect(screen.getByTestId("values")).toHaveTextContent(
      "Cached user message"
    );

    // Submitting should clear out the cached messages
    await user.click(screen.getByTestId("submit"));

    // Wait for messages to appear
    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1")).toHaveTextContent("Hey");
    });
  });

  it("accepts newThreadId option without errors", async () => {
    const user = userEvent.setup();

    const spy = vi.fn();
    const predeterminedThreadId = randomUUID();

    // Test that newThreadId option can be passed without causing errors
    function TestNewThreadComponent() {
      const stream = useStream<{ messages: Message[] }>({
        assistantId: "agent",
        apiKey: "test-api-key",
        threadId: null, // Start with no thread
        onThreadId: spy, // Mock callback
      });

      return (
        <div>
          <div data-testid="loading">
            {stream.isLoading ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="thread-id">
            {stream.client ? "Client ready" : "No client"}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              stream.submit({}, { threadId: predeterminedThreadId })
            }
          >
            Submit
          </button>
        </div>
      );
    }

    render(<TestNewThreadComponent />);

    // Should render without errors
    expect(screen.getByTestId("loading")).toHaveTextContent("Not loading");
    expect(screen.getByTestId("thread-id")).toHaveTextContent("Client ready");

    await user.click(screen.getByTestId("submit"));
    expect(spy).toHaveBeenCalledWith(predeterminedThreadId);
    expect(await threads.get(predeterminedThreadId)).toEqual({
      thread_id: predeterminedThreadId,
      metadata: {
        graph_id: "agent",
        assistant_id: "agent",
      },
    });
  });

  it("onStop callback is called when stop is called", async () => {
    const user = userEvent.setup();
    const onStopCallback = vi.fn();

    function TestComponent() {
      const { submit, stop } = useStream({
        assistantId: "agent",
        apiKey: "test-api-key",
        onStop: onStopCallback,
      });

      return (
        <div>
          <button data-testid="submit" onClick={() => submit({})}>
            Send
          </button>
          <button data-testid="stop" onClick={stop}>
            Stop
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    // Start a stream and stop it
    await user.click(screen.getByTestId("submit"));
    await user.click(screen.getByTestId("stop"));

    // Verify onStop was called with mutate function
    expect(onStopCallback).toHaveBeenCalledTimes(1);
    expect(onStopCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        mutate: expect.any(Function),
      })
    );
  });

  it("onStop mutate function updates stream values immediately", async () => {
    const user = userEvent.setup();

    function TestComponent() {
      const [stopped, setStopped] = useState(false);
      const { submit, stop, messages } = useStream<{ messages: Message[] }>({
        assistantId: "agent",
        apiKey: "test-api-key",
        onStop: ({ mutate }) => {
          setStopped(true);
          mutate((prev) => ({
            ...prev,
            messages: [{ type: "ai", content: "Stream stopped" }],
          }));
        },
      });

      return (
        <div>
          <div data-testid="stopped-status">
            {stopped ? "Stopped" : "Not stopped"}
          </div>
          <div data-testid="messages">
            {messages.map((msg, i) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button data-testid="submit" onClick={() => submit({})}>
            Send
          </button>
          <button data-testid="stop" onClick={stop}>
            Stop
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    // Initial state
    expect(screen.getByTestId("stopped-status")).toHaveTextContent(
      "Not stopped"
    );

    // Start and stop stream
    await user.click(screen.getByTestId("submit"));
    await user.click(screen.getByTestId("stop"));

    // Verify state was updated immediately
    await waitFor(() => {
      expect(screen.getByTestId("stopped-status")).toHaveTextContent("Stopped");
      expect(screen.getByTestId("message-0")).toHaveTextContent(
        "Stream stopped"
      );
    });
  });

  it("onStop handles functional updates correctly", async () => {
    const user = userEvent.setup();

    function TestComponent() {
      const { submit, stop, values } = useStream({
        assistantId: "agent",
        apiKey: "test-api-key",
        initialValues: {
          counter: 5,
          items: ["item1", "item2"],
        },
        onStop: ({ mutate }) => {
          mutate((prev: any) => ({
            ...prev,
            counter: (prev.counter || 0) + 10,
            items: [...(prev.items || []), "stopped"],
          }));
        },
      });

      return (
        <div>
          <div data-testid="counter">{(values as any).counter}</div>
          <div data-testid="items">{(values as any).items?.join(", ")}</div>
          <button data-testid="submit" onClick={() => submit({})}>
            Send
          </button>
          <button data-testid="stop" onClick={stop}>
            Stop
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    // Initial state
    expect(screen.getByTestId("counter")).toHaveTextContent("5");
    expect(screen.getByTestId("items")).toHaveTextContent("item1, item2");

    // Start and stop stream
    await user.click(screen.getByTestId("submit"));
    await user.click(screen.getByTestId("stop"));

    // Verify functional update was applied correctly
    await waitFor(() => {
      expect(screen.getByTestId("counter")).toHaveTextContent("15");
      expect(screen.getByTestId("items")).toHaveTextContent(
        "item1, item2, stopped"
      );
    });
  });

  it("onStop is not called when stream completes naturally", async () => {
    const user = userEvent.setup();

    const onStopCallback = vi.fn();

    function TestComponent() {
      const { submit } = useStream({
        assistantId: "agent",
        apiKey: "test-api-key",
        onStop: onStopCallback,
      });

      return (
        <div>
          <button data-testid="submit" onClick={() => submit({})}>
            Send
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    // Start a stream and let it complete naturally
    await user.click(screen.getByTestId("submit"));

    // Wait for stream to complete naturally
    await waitFor(() => {
      expect(onStopCallback).not.toHaveBeenCalled();
    });
  });

  it("make sure to pass metadata to the thread", async () => {
    const user = userEvent.setup();

    const onStopCallback = vi.fn();
    const threadId = randomUUID();

    function TestComponent() {
      const { submit, messages } = useStream({
        assistantId: "agent",
        apiKey: "test-api-key",
        onStop: onStopCallback,
      });

      return (
        <div>
          <div data-testid="messages">
            {messages.map((msg, i) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              submit(
                { messages: [{ content: "Hello", type: "human" }] },
                { metadata: { random: "123" }, threadId }
              )
            }
          >
            Send
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    await user.click(screen.getByTestId("submit"));

    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1")).toHaveTextContent("Hey");
    });

    const client = new Client();

    const thread = await client.threads.get(threadId);
    expect(thread.metadata).toMatchObject({ random: "123" });
  });

  it("branching", async () => {
    const user = userEvent.setup();

    function BranchControls(props: {
      branch: string | undefined;
      branchOptions: string[] | undefined;
      onSelect: (branch: string) => void;
    }) {
      if (!props.branchOptions || !props.branch) return null;
      const index = props.branchOptions.indexOf(props.branch);

      return (
        <div role="navigation">
          <button
            type="button"
            onClick={() => {
              const prevBranch = props.branchOptions?.[index - 1];
              if (!prevBranch) return;
              props.onSelect(prevBranch);
            }}
          >
            Previous
          </button>

          <span>
            {index + 1} / {props.branchOptions.length}
          </span>

          <button
            type="button"
            onClick={() => {
              const nextBranch = props.branchOptions?.[index + 1];
              if (!nextBranch) return;
              props.onSelect(nextBranch);
            }}
          >
            Next
          </button>
        </div>
      );
    }

    function TestComponent() {
      const { submit, messages, getMessagesMetadata, setBranch } = useStream({
        assistantId: "agent",
        apiKey: "test-api-key",
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

              return (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  <div className="content" role="text">
                    {text}
                  </div>

                  <BranchControls
                    branch={metadata?.branch}
                    branchOptions={metadata?.branchOptions}
                    onSelect={setBranch}
                  />

                  {msg.type === "human" && (
                    <button
                      type="button"
                      onClick={() => {
                        const messages = {
                          type: "human",
                          content: `Fork: ${text}`,
                        };

                        submit({ messages: [messages] }, { checkpoint });
                      }}
                    >
                      Fork
                    </button>
                  )}

                  {msg.type === "ai" && (
                    <button
                      type="button"
                      onClick={() => submit(undefined, { checkpoint })}
                    >
                      Regenerate
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const formData = new FormData(e.target as HTMLFormElement);
              const content = formData.get("input") as string;
              submit({ messages: [{ type: "human", content }] });
            }}
          >
            <input type="text" placeholder="Input" name="input" />
            <button type="submit">Send</button>
          </form>
        </div>
      );
    }

    render(<TestComponent />);

    await user.type(screen.getByPlaceholderText("Input"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("message-0")).getByRole("text")
      ).toHaveTextContent("Hello");
      expect(
        within(screen.getByTestId("message-1")).getByRole("text")
      ).toHaveTextContent("Hey");
      expect(
        within(screen.getByTestId("message-0")).queryByRole("navigation")
      ).not.toBeInTheDocument();
    });

    // Retry the second message
    await user.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("message-0")).getByRole("text")
      ).toHaveTextContent("Hello");
      expect(
        within(screen.getByTestId("message-1")).getByRole("text")
      ).toHaveTextContent("Hey");
      expect(
        within(screen.getByTestId("message-1")).getByRole("navigation")
      ).toHaveTextContent("2 / 2");
    });

    // Fork the first message
    await user.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("message-0")).getByRole("text")
      ).toHaveTextContent("Fork: Hello");
      expect(
        within(screen.getByTestId("message-0")).getByRole("navigation")
      ).toHaveTextContent("2 / 2");

      expect(
        within(screen.getByTestId("message-1")).getByRole("text")
      ).toHaveTextContent("Hey");
      expect(
        within(screen.getByTestId("message-1")).queryByRole("navigation")
      ).not.toBeInTheDocument();
    });

    await user.click(
      within(screen.getByTestId("message-0")).getByRole("button", {
        name: "Previous",
      })
    );

    await waitFor(() => {
      expect(
        within(screen.getByTestId("message-0")).getByRole("text")
      ).toHaveTextContent("Hello");
      expect(
        within(screen.getByTestId("message-0")).getByRole("navigation")
      ).toHaveTextContent("1 / 2");
      expect(
        within(screen.getByTestId("message-1")).getByRole("text")
      ).toHaveTextContent("Hey");
      expect(
        within(screen.getByTestId("message-1")).getByRole("navigation")
      ).toHaveTextContent("2 / 2");
    });

    await user.click(
      within(screen.getByTestId("message-1")).getByRole("button", {
        name: "Previous",
      })
    );

    await waitFor(() => {
      expect(
        within(screen.getByTestId("message-0")).getByRole("text")
      ).toHaveTextContent("Hello");
      expect(
        within(screen.getByTestId("message-0")).getByRole("navigation")
      ).toHaveTextContent("1 / 2");
      expect(
        within(screen.getByTestId("message-1")).getByRole("text")
      ).toHaveTextContent("Hey");
      expect(
        within(screen.getByTestId("message-1")).getByRole("navigation")
      ).toHaveTextContent("1 / 2");
    });
  });

  it("fetchStateHistory: false", async () => {
    const user = userEvent.setup();

    function TestComponent() {
      const { submit, messages } = useStream({
        assistantId: "agent",
        apiKey: "test-api-key",
        fetchStateHistory: false,
      });

      return (
        <div>
          <div data-testid="messages">
            {messages.map((msg, i) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    await user.click(screen.getByTestId("submit"));

    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1")).toHaveTextContent("Hey");
    });
  });

  it("streamSubgraphs: true and messages-tuple", async () => {
    const user = userEvent.setup();

    function TestComponent() {
      const { submit, messages } = useStream({
        assistantId: "parentAgent",
        apiKey: "test-api-key",
      });

      return (
        <div>
          <div data-testid="messages">
            {messages.map((msg, i) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              submit(
                { messages: [{ content: "Hello", type: "human" }] },
                { streamSubgraphs: true }
              )
            }
          >
            Send
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    await user.click(screen.getByTestId("submit"));

    // Make sure that we're properly streaming the tokens from subgraphs
    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1").textContent).toBe("H");
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1").textContent).toBe("He");
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1").textContent).toBe("Hey");
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("message-1").textContent).toBe("Hey");
    });
  });

  it("streamMetadata", async () => {
    const user = userEvent.setup();

    function TestComponent() {
      const { submit, messages, getMessagesMetadata } = useStream({
        assistantId: "agent",
        apiKey: "test-api-key",
      });

      return (
        <div>
          <div data-testid="messages">
            {messages.map((msg, i) => {
              const metadata = getMessagesMetadata(msg, i);
              return (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  {typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content)}

                  {metadata?.streamMetadata && (
                    <div data-testid="stream-metadata">
                      {metadata.streamMetadata?.langgraph_node as string}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
        </div>
      );
    }

    render(<TestComponent />);

    await user.click(screen.getByTestId("submit"));

    await waitFor(() => {
      expect(screen.getByTestId("message-0")).toHaveTextContent("Hello");
      expect(screen.getByTestId("stream-metadata")).toHaveTextContent("agent");
    });
  });
});

import { Client } from "@langchain/langgraph-sdk";
import { it, expect, vi, inject } from "vitest";
import { render } from "vitest-browser-svelte";
import BasicStream from "./components/BasicStream.svelte";
import MessageRemoval from "./components/MessageRemoval.svelte";
import MultiSubmit from "./components/MultiSubmit.svelte";
import ToolCallsStream from "./components/ToolCallsStream.svelte";
import InterruptsArray from "./components/InterruptsArray.svelte";
import SwitchThread from "./components/SwitchThread.svelte";
import SubmitOnError from "./components/SubmitOnError.svelte";
import CustomStreamMethods from "./components/CustomStreamMethods.svelte";
import CustomTransportStreamSubgraphs from "./components/CustomTransportStreamSubgraphs.svelte";
import StreamContextParent from "./components/StreamContextParent.svelte";
import StreamContextOrphan from "./components/StreamContextOrphan.svelte";
import ContextProvider from "./components/ContextProvider.svelte";
import { getStream, type AgentServerAdapter } from "../index.js";

type AdapterCommand = Parameters<AgentServerAdapter["send"]>[0];

const serverUrl = inject("serverUrl");

it("renders initial state correctly", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("error")).not.toBeInTheDocument();
});

it("handles message submission and streaming", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("handles stop functionality", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("onStop does not clear stream values", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");
});

it("make sure to pass metadata to the thread", async () => {
  const threadId = crypto.randomUUID();

  const screen = render(BasicStream, {
    apiUrl: serverUrl,
    submitOptions: { metadata: { random: "123" }, threadId },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  const client = new Client({ apiUrl: serverUrl });
  await expect
    .poll(async () => {
      const thread = await client.threads.get(threadId);
      return thread.metadata;
    })
    .toMatchObject({ random: "123" });
});

it("handle message removal", async () => {
  const messagesValues = new Set<string>();

  const screen = render(MessageRemoval, {
    apiUrl: serverUrl,
    onRender: (msgs: string[]) => {
      messagesValues.add(msgs.join("\n"));
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("human: Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("ai: Step 2: To Keep");
  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("ai: Step 3: To Keep");

  const observed = [...messagesValues.values()];
  expect(observed).toContain("");
  const finalState = observed[observed.length - 1];
  expect(finalState).toBe(
    ["human: Hello", "ai: Step 2: To Keep", "ai: Step 3: To Keep"].join("\n"),
  );
  expect(finalState).not.toContain("Step 1: To Remove");
});

it("enqueue multiple .submit() calls", async () => {
  const messagesValues = new Set<string>();

  const screen = render(MultiSubmit, {
    apiUrl: serverUrl,
    onRender: (msgs: string[]) => {
      messagesValues.add(msgs.join("\n"));
    },
  });

  await screen.getByTestId("submit-first").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello (1)");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await screen.getByTestId("submit-second").click();

  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("Hello (2)");
  await expect
    .element(screen.getByTestId("message-3"))
    .toHaveTextContent("Hey");
});

it("exposes toolCalls property", async () => {
  const screen = render(ToolCallsStream, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("tool-calls-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("tool-calls-count"))
    .toHaveTextContent("1");
});

it("exposes interrupts array", async () => {
  const screen = render(InterruptsArray, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("interrupts-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .poll(() => screen.getByTestId("interrupts-count").element().textContent)
    .toBe("1");
});

it("switchThread clears messages and starts fresh", async () => {
  const screen = render(SwitchThread, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");

  const firstMessage = screen
    .getByTestId("message-0")
    .element()
    .textContent?.trim();

  await screen.getByTestId("switch-thread").click();

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");

  const secondMessage = screen
    .getByTestId("message-0")
    .element()
    .textContent?.trim();
  expect(secondMessage).toBe(firstMessage);
});

it("switchThread to null clears messages", async () => {
  const screen = render(SwitchThread, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");

  await screen.getByTestId("switch-thread-null").click();

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");
});

it("custom adapter stream supports local branch UI", async () => {
  const screen = render(CustomStreamMethods, {
    apiUrl: serverUrl,
  });

  await expect.element(screen.getByTestId("branch")).toHaveTextContent("");

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("message-0")).toHaveTextContent("Hi");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hello!");

  await screen.getByTestId("set-branch").click();

  await expect
    .element(screen.getByTestId("branch"))
    .toHaveTextContent("test-branch");
});

it("useStream forwards submissions to a custom AgentServerAdapter", async () => {
  const onCommand = vi.fn<(command: AdapterCommand) => void>();

  const screen = render(CustomTransportStreamSubgraphs, {
    onCommand,
  });

  await screen.getByTestId("submit-custom-subgraphs").click();

  await expect.poll(() => onCommand.mock.calls.length).toBeGreaterThan(0);
  expect(onCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "run.start",
      params: expect.objectContaining({
        input: {
          messages: [{ type: "human", content: "Hi" }],
        },
        config: expect.objectContaining({
          configurable: expect.objectContaining({
            thread_id: expect.any(String),
          }),
        }),
      }),
    })
  );
});

it("calls per-submit onError when stream fails", async () => {
  const screen = render(SubmitOnError, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("submit-error")).toBeInTheDocument();

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

// Stream context tests (main branch)
it("provideStream / getStream shares stream with child components", async () => {
  const screen = render(StreamContextParent, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("parent-submit").click();

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("parent-message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("parent-message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("child-message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("child-message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Not loading");
});

it("getStream throws when no parent has provided context", async () => {
  const screen = render(StreamContextOrphan);

  await expect
    .element(screen.getByTestId("orphan-error"))
    .toHaveTextContent(
      "getStream() requires a parent component to call provideStream().",
    );
});

// provideStream / getStream context tests
it("provideStream shares stream state across child components", async () => {
  const screen = render(ContextProvider, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
});

it("provideStream children can submit and receive messages", async () => {
  const screen = render(ContextProvider, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("provideStream children can stop the stream", async () => {
  const screen = render(ContextProvider, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("getStream throws when used outside a component", () => {
  expect(() => {
    getStream();
  }).toThrow();
});


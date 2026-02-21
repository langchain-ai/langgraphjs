import type { LocatorSelectors } from "@vitest/browser/context";
import { Client } from "@langchain/langgraph-sdk";
import { it, expect, vi, inject } from "vitest";
import { render } from "vitest-browser-angular";
import { BasicStreamComponent } from "./components/BasicStream.js";
import { InitialValuesComponent } from "./components/InitialValuesStream.js";
import { OnStopCallbackComponent } from "./components/OnStopCallback.js";
import { StopMutateComponent } from "./components/StopMutateStream.js";
import { StopFunctionalComponent } from "./components/StopFunctionalStream.js";
import { StreamMetadataComponent } from "./components/StreamMetadata.js";
import {
  SubgraphStreamComponent,
  checkpointCalls,
  taskCalls,
  updateCalls,
  customCalls,
  resetSubgraphCalls,
} from "./components/SubgraphStream.js";
import { InterruptComponent } from "./components/InterruptStream.js";
import { MessageRemovalComponent } from "./components/MessageRemoval.js";
import { MultiSubmitComponent } from "./components/MultiSubmit.js";
import { NewThreadIdComponent } from "./components/NewThreadId.js";
import { BranchingComponent } from "./components/Branching.js";
import {
  OnRequestComponent,
  onRequestCalls,
  resetOnRequestCalls,
} from "./components/OnRequest.js";
import { BasicStreamWithHistoryComponent } from "./components/BasicStreamWithHistory.js";
import { InterruptWithHistoryComponent } from "./components/InterruptStreamWithHistory.js";

declare module "vitest-browser-angular" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RenderResult<T> extends LocatorSelectors {}
}

const serverUrl = inject("serverUrl");

it("renders initial state correctly", async () => {
  const screen = await render(BasicStreamComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-0"))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId("error"))
    .not.toBeInTheDocument();
});

it("handles message submission and streaming", async () => {
  const screen = await render(BasicStreamComponent);

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
  const screen = await render(BasicStreamComponent);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("displays initial values immediately and clears them when submitting", async () => {
  const screen = await render(InitialValuesComponent);

  await expect
    .element(screen.getByTestId("message-cached-0"))
    .toHaveTextContent("Cached user message");
  await expect
    .element(screen.getByTestId("message-cached-1"))
    .toHaveTextContent("Cached AI response");

  await expect
    .element(screen.getByTestId("values"))
    .toHaveTextContent("Cached user message");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
});

it("onStop does not clear stream values", async () => {
  const screen = await render(BasicStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("H");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("H");
});

it("onStop callback is called when stop is called", async () => {
  const screen = await render(OnStopCallbackComponent);

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("Yes");
  await expect
    .element(screen.getByTestId("has-mutate"))
    .toHaveTextContent("Yes");
});

it("onStop mutate function updates stream values immediately", async () => {
  const screen = await render(StopMutateComponent, {
    inputs: {
      onStopMutate: (prev: Record<string, unknown>) => ({
        ...prev,
        messages: [{ type: "ai", content: "Stream stopped" }],
      }),
    },
  });

  await expect
    .element(screen.getByTestId("stopped-status"))
    .toHaveTextContent("Not stopped");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("stopped-status"))
    .toHaveTextContent("Stopped");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Stream stopped");
});

it("onStop handles functional updates correctly", async () => {
  const screen = await render(StopFunctionalComponent, {
    inputs: {
      onStopMutate: (prev: any) => ({
        ...prev,
        counter: (prev.counter || 0) + 10,
        items: [...(prev.items || []), "stopped"],
      }),
    },
  });

  await expect
    .element(screen.getByTestId("counter"))
    .toHaveTextContent("5");
  await expect
    .element(screen.getByTestId("items"))
    .toHaveTextContent("item1, item2");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("counter"))
    .toHaveTextContent("15");
  await expect
    .element(screen.getByTestId("items"))
    .toHaveTextContent("item1, item2, stopped");
});

it("onStop is not called when stream completes naturally", async () => {
  const screen = await render(OnStopCallbackComponent);

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");

  await screen.getByTestId("submit").click();

  await new Promise((r) => {
    setTimeout(r, 1500);
  });

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");
});

it("make sure to pass metadata to the thread", async () => {
  const threadId = crypto.randomUUID();

  const screen = await render(BasicStreamComponent, {
    inputs: {
      submitOptions: { metadata: { random: "123" }, threadId },
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  const client = new Client({ apiUrl: serverUrl });
  const thread = await client.threads.get(threadId);
  expect(thread.metadata).toMatchObject({ random: "123" });
});

it("streamSubgraphs: true", async () => {
  resetSubgraphCalls();

  const screen = await render(SubgraphStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .poll(() => checkpointCalls.length)
    .toBeGreaterThanOrEqual(6);

  expect(checkpointCalls).toMatchObject([
    [{ metadata: { source: "input", step: -1 } }, { namespace: undefined }],
    [{ metadata: { source: "loop", step: 0 } }, { namespace: undefined }],
    [
      { metadata: { source: "input", step: -1 } },
      { namespace: [expect.any(String)] },
    ],
    [
      { metadata: { source: "loop", step: 0 } },
      { namespace: [expect.any(String)] },
    ],
    [
      { metadata: { source: "loop", step: 1 } },
      { namespace: [expect.any(String)] },
    ],
    [{ metadata: { source: "loop", step: 1 } }, { namespace: undefined }],
  ]);

  expect(taskCalls).toMatchObject([
    [{ name: "child", input: expect.anything() }, { namespace: undefined }],
    [
      { name: "agent", input: expect.anything() },
      { namespace: [expect.any(String)] },
    ],
    [
      { name: "agent", result: expect.anything() },
      { namespace: [expect.any(String)] },
    ],
    [{ name: "child", result: expect.anything() }, { namespace: undefined }],
  ]);

  expect(updateCalls).toMatchObject([
    [
      { agent: { messages: expect.anything() } },
      { namespace: [expect.any(String)] },
    ],
    [{ child: { messages: expect.anything() } }, { namespace: undefined }],
  ]);

  expect(customCalls).toMatchObject([
    ["Custom events", { namespace: [expect.any(String)] }],
  ]);
});

it("streamMetadata", async () => {
  const screen = await render(StreamMetadataComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("stream-metadata"))
    .toHaveTextContent("agent");
});

it("interrupts (fetchStateHistory: false)", async () => {
  const screen = await render(InterruptComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("breakpoint");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("agent");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("Hey: Resuming");
  await expect
    .element(screen.getByTestId("message-3"))
    .toHaveTextContent("After interrupt");
});

it("handle message removal", async () => {
  const messagesValues = new Set<string>();

  const screen = await render(MessageRemovalComponent, {
    inputs: {
      onRender: (msgs: string[]) => {
        messagesValues.add(msgs.join("\n"));
      },
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

  const captured = [...messagesValues.values()];
  expect(captured[0]).toBe("");
  const finalState = captured[captured.length - 1];
  expect(finalState).toContain("human: Hello");
  expect(finalState).not.toContain("Step 1: To Remove");
  expect(finalState).toContain("ai: Step 2: To Keep");
  expect(finalState).toContain("ai: Step 3: To Keep");
});

it("enqueue multiple .submit() calls", async () => {
  const messagesValues = new Set<string>();

  const screen = await render(MultiSubmitComponent, {
    inputs: {
      onRender: (msgs: string[]) => {
        messagesValues.add(msgs.join("\n"));
      },
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

it("accepts newThreadId option without errors", async () => {
  const spy = vi.fn();
  const predeterminedThreadId = crypto.randomUUID();

  const screen = await render(NewThreadIdComponent, {
    inputs: {
      onThreadIdCb: spy,
      submitThreadId: predeterminedThreadId,
    },
  });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent("Client ready");

  await screen.getByTestId("submit").click();

  await expect.poll(() => spy).toHaveBeenCalledWith(predeterminedThreadId);

  const client = new Client({ apiUrl: serverUrl });
  const thread = await client.threads.get(predeterminedThreadId);
  expect(thread.metadata).toMatchObject({
    graph_id: "agent",
    assistant_id: "agent",
  });
});

it("branching", async () => {
  const screen = await render(BranchingComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-nav-0"))
    .not.toBeInTheDocument();

  await screen.getByTestId("regenerate-1").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("2 / 2");

  await screen.getByTestId("fork-0").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Fork: Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("2 / 2");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-nav-1"))
    .not.toBeInTheDocument();

  await screen.getByTestId("prev-0").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("1 / 2");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("2 / 2");

  await screen.getByTestId("prev-1").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("1 / 2");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("1 / 2");
});

it("fetchStateHistory: { limit: 2 }", async () => {
  const screen = await render(BasicStreamWithHistoryComponent);

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

it("onRequest gets called when a request is made", async () => {
  resetOnRequestCalls();

  const screen = await render(OnRequestComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  expect(onRequestCalls).toMatchObject([
    [expect.stringContaining("/threads"), { method: "POST" }],
    [
      expect.stringContaining("/runs/stream"),
      {
        method: "POST",
        body: {
          input: { messages: [{ content: "Hello", type: "human" }] },
          assistant_id: "agent",
        },
      },
    ],
  ]);
});

it("interrupts (fetchStateHistory: true)", async () => {
  const screen = await render(InterruptWithHistoryComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("breakpoint");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("agent");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("Hey: Resuming");
  await expect
    .element(screen.getByTestId("message-3"))
    .toHaveTextContent("After interrupt");
});

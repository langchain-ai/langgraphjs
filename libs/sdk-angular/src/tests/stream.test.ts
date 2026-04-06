import { Component } from "@angular/core";
import type { LocatorSelectors } from "@vitest/browser/context";
import { Client } from "@langchain/langgraph-sdk";
import type { BaseMessage } from "langchain";
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
import {
  CustomTransportStreamSubgraphsComponent,
  customStreamTransportHolder,
} from "./components/CustomTransportStreamSubgraphs.js";
import { CustomStreamMethodsComponent } from "./components/CustomStreamMethods.js";
import { InterruptWithHistoryComponent } from "./components/InterruptStreamWithHistory.js";
import { ToolCallsComponent } from "./components/ToolCallsStream.js";
import { InterruptsArrayComponent } from "./components/InterruptsArray.js";
import { SwitchThreadComponent } from "./components/SwitchThread.js";
import { QueueStreamComponent } from "./components/QueueStream.js";
import { QueueOnCreatedComponent } from "./components/QueueOnCreated.js";
import { SubmitOnErrorComponent } from "./components/SubmitOnError.js";
import { DeepAgentStreamComponent } from "./components/DeepAgentStream.js";
import { RetainedSubagentStreamComponent } from "./components/RetainedSubagentStream.js";
import { HistoryMessagesComponent } from "./components/HistoryMessages.js";
import {
  HeadlessToolComponent,
  HeadlessToolErrorComponent,
} from "./components/HeadlessToolStream.js";
import { StreamServiceBasicComponent } from "./components/StreamServiceBasic.js";
import { StreamServiceCustomTransportComponent } from "./components/StreamServiceCustomTransport.js";
import { StreamServiceSharedComponent } from "./components/StreamServiceShared.js";
import { ContextProviderComponent } from "./components/ContextProvider.js";
import { injectStream, type UseStreamTransport } from "../index.js";

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
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("error")).not.toBeInTheDocument();
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
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");
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

  await expect.element(screen.getByTestId("counter")).toHaveTextContent("5");
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

  await expect.element(screen.getByTestId("counter")).toHaveTextContent("15");
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
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");
  await expect
    .element(screen.getByTestId("has-mutate"))
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
  await expect
    .poll(async () => {
      const thread = await client.threads.get(threadId);
      return thread.metadata;
    })
    .toMatchObject({ random: "123" });
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

  await expect.poll(() => checkpointCalls.length).toBeGreaterThanOrEqual(6);

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

it("handles subgraph streaming with event callbacks", async () => {
  const onCheckpointEvent = vi.fn();
  const onUpdateEvent = vi.fn();
  const onCustomEvent = vi.fn();

  const screen = await render(SubgraphStreamComponent, {
    inputs: {
      onCheckpointEvent,
      onUpdateEvent,
      onCustomEvent,
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .poll(() => onCheckpointEvent.mock.calls.length)
    .toBeGreaterThanOrEqual(6);

  expect(
    onCheckpointEvent.mock.calls.some(
      (call: any[]) => call[1]?.namespace !== undefined,
    ),
  ).toBe(true);

  expect(onUpdateEvent.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(onCustomEvent.mock.calls.length).toBeGreaterThanOrEqual(1);
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
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const client = new Client({
    apiUrl: serverUrl,
    onRequest: (url: any, init: any) => {
      requests.push({
        url: url.toString(),
        body: init.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : undefined,
      });
      return init;
    },
  });

  @Component({
    template: `
      <div>
        <div data-testid="messages">
          @for (msg of stream.messages(); track msg.id ?? $index) {
            <div [attr.data-testid]="'message-' + $index">
              {{ str(msg.content) }}
            </div>
          }
        </div>
        <div data-testid="loading">
          {{ stream.isLoading() ? "Loading..." : "Not loading" }}
        </div>
        <button data-testid="submit" (click)="onSubmit()">Send</button>
      </div>
    `,
  })
  class FetchStateHistoryComponent {
    stream = injectStream({
      assistantId: "agent",
      apiUrl: serverUrl,
      client,
      fetchStateHistory: { limit: 2 },
    });

    str(v: unknown) {
      return typeof v === "string" ? v : JSON.stringify(v);
    }

    onSubmit() {
      void this.stream.submit({
        messages: [{ content: "Hello", type: "human" }],
      } as any);
    }
  }

  const screen = await render(FetchStateHistoryComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .poll(
      () => requests.find((call) => call.url.includes("/history"))?.body?.limit,
      { timeout: 10_000 },
    )
    .toBe(2);
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

it("exposes toolCalls property", async () => {
  const screen = await render(ToolCallsComponent);

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
  const screen = await render(InterruptsArrayComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("interrupts-count"))
    .toHaveTextContent("1");
});

it("switchThread clears messages and starts fresh", async () => {
  const screen = await render(SwitchThreadComponent);

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
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello from");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Reply on");

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
  expect(secondMessage).not.toBe(firstMessage);
});

it("switchThread to null clears messages", async () => {
  const screen = await render(SwitchThreadComponent);

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

it("injectStreamCustom exposes getMessagesMetadata, branch, setBranch", async () => {
  const screen = await render(CustomStreamMethodsComponent);

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

it("injectStreamCustom forwards streamSubgraphs to custom transport", async () => {
  type StreamState = { messages: BaseMessage[] };
  const streamTransport = vi.fn<UseStreamTransport<StreamState>["stream"]>(
    async () => {
      async function* generate(): AsyncGenerator<{
        event: string;
        data: unknown;
      }> {
        yield {
          event: "values",
          data: {
            messages: [
              { id: "human-1", type: "human", content: "Hi" },
              { id: "ai-1", type: "ai", content: "Hello!" },
            ],
          },
        };
      }

      return generate();
    },
  );

  customStreamTransportHolder.stream = streamTransport;

  try {
    const screen = await render(CustomTransportStreamSubgraphsComponent);

    await screen.getByTestId("submit-custom-subgraphs").click();

    await expect.poll(() => streamTransport.mock.calls.length).toBe(1);
    expect(streamTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          messages: [{ type: "human", content: "Hi" }],
        },
        streamSubgraphs: true,
        config: expect.objectContaining({
          configurable: expect.objectContaining({
            thread_id: expect.any(String),
          }),
        }),
      }),
    );
  } finally {
    delete customStreamTransportHolder.stream;
  }
});

// Server-side queue e2e tests
it("server-side queue: submitting three times rapidly queues the latter two", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 10000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  const count = parseInt(
    screen.getByTestId("message-count").element().textContent ?? "0",
    10,
  );
  expect(count).toBeGreaterThanOrEqual(2);
});

it("server-side queue: queued inputs are displayed in queue.entries", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  const entriesEl = screen.getByTestId("queue-entries");
  await expect.element(entriesEl, { timeout: 5000 }).toHaveTextContent(/Msg\d/);
});

it("server-side queue: cancel removes a queued entry", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await screen.getByTestId("cancel-first").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 10000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");
});

it("server-side queue: clear empties the queue", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await screen.getByTestId("clear-queue").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");
});

it("server-side queue: switchThread clears the queue", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await screen.getByTestId("switch-thread").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("message-count"), { timeout: 5000 })
    .toHaveTextContent("0");
});

it("server-side queue: follow-ups submitted from onCreated are drained", async () => {
  const screen = await render(QueueOnCreatedComponent);

  await screen.getByTestId("submit-presets").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 15000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("0");

  const count = parseInt(
    screen.getByTestId("message-count").element().textContent ?? "0",
    10,
  );
  expect(count).toBeGreaterThanOrEqual(6);
});

it("calls per-submit onError when stream fails", async () => {
  const screen = await render(SubmitOnErrorComponent);

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("submit-error")).toBeInTheDocument();

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("deep agent: subagents call tools and render args/results", async () => {
  const screen = await render(DeepAgentStreamComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 30_000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("subagent-researcher-status"))
    .toHaveTextContent("complete");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-status"))
    .toHaveTextContent("complete");

  await expect
    .element(screen.getByTestId("subagent-researcher-task-description"))
    .toHaveTextContent("Search the web for test research query");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-task-description"))
    .toHaveTextContent("Query the database for test data");

  await expect
    .element(screen.getByTestId("subagent-researcher-result"))
    .toHaveTextContent(/Result for: test research query/);
  await expect
    .element(screen.getByTestId("subagent-data-analyst-result"))
    .toHaveTextContent(/Record A/);
  await expect
    .element(screen.getByTestId("subagent-data-analyst-result"))
    .toHaveTextContent(/Record B/);

  // Verify subagent internal messages are populated (requires streamSubgraphs + filterSubagentMessages)
  await expect
    .element(screen.getByTestId("subagent-researcher-messages-count"), {
      timeout: 5_000,
    })
    .not.toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-messages-count"))
    .not.toHaveTextContent("0");

  // Verify subagent tool calls are captured
  await expect
    .element(screen.getByTestId("subagent-researcher-toolcalls-count"))
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-toolcalls-count"))
    .toHaveTextContent("1");

  // Verify the correct tools were called within each subagent
  await expect
    .element(screen.getByTestId("subagent-researcher-toolcall-names"))
    .toHaveTextContent("search_web");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-toolcall-names"))
    .toHaveTextContent("query_database");

  // Verify tool call state transitions (pending → completed)
  const observedStates = screen.getByTestId("observed-toolcall-states");
  const observedSubagentStatuses = screen.getByTestId(
    "observed-subagent-statuses",
  );
  await expect
    .element(observedSubagentStatuses)
    .toHaveTextContent(/data-analyst:(pending|running|complete)/);
  await expect
    .element(observedSubagentStatuses)
    .toHaveTextContent(/researcher:(pending|running|complete)/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/data-analyst:query_database:pending/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/researcher:search_web:pending/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/data-analyst:query_database:completed/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/researcher:search_web:completed/);

  const messages = screen.getByTestId("messages");
  await expect.element(messages).toHaveTextContent(/Run analysis/);
  await expect.element(messages).toHaveTextContent(/tool_call:task/);
  await expect.element(messages).toHaveTextContent(/researcher/);
  await expect.element(messages).toHaveTextContent(/data-analyst/);
  await expect.element(messages).toHaveTextContent(/tool_result:/);
  await expect
    .element(messages)
    .toHaveTextContent(/Both agents completed their tasks/);
});

it("deep agent: retained subagent references stay reactive", async () => {
  const screen = await render(RetainedSubagentStreamComponent);

  await expect
    .element(screen.getByTestId("retained-subagent-status"))
    .toHaveTextContent("missing");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("retained-subagent-toolcalls"), {
      timeout: 30_000,
    })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("retained-subagent-status"))
    .toHaveTextContent("complete");
});

it("deep agent: retained subagent summaries react to latest tool calls", async () => {
  const screen = await render(RetainedSubagentStreamComponent);

  await expect
    .element(screen.getByTestId("retained-subagent-latest-tool"))
    .toHaveTextContent("missing");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("retained-subagent-task"), {
      timeout: 30_000,
    })
    .toHaveTextContent("Search the web for test research query");
  await expect
    .element(screen.getByTestId("retained-subagent-latest-tool"))
    .toHaveTextContent("search_web");
  await expect
    .element(screen.getByTestId("retained-subagent-latest-tool-args"))
    .toHaveTextContent('"query":"test research query"');
});

it("stream.history returns BaseMessage instances", async () => {
  const screen = await render(HistoryMessagesComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("history-count"))
    .not.toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("history-all-base-message"))
    .toHaveTextContent("true");
  await expect
    .element(screen.getByTestId("history-message-types"))
    .toHaveTextContent(/human/);
  await expect
    .element(screen.getByTestId("history-message-types"))
    .toHaveTextContent(/ai/);
});

// StreamService tests
it("StreamService: renders initial state correctly", async () => {
  const screen = await render(StreamServiceBasicComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("error")).not.toBeInTheDocument();
});

it("StreamService: handles message submission and streaming", async () => {
  const screen = await render(StreamServiceBasicComponent);

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

it("StreamService: handles stop functionality", async () => {
  const screen = await render(StreamServiceBasicComponent);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("StreamService: works with custom transport", async () => {
  const screen = await render(StreamServiceCustomTransportComponent);

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

it("StreamService: shares state between parent and child components", async () => {
  const screen = await render(StreamServiceSharedComponent);

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("parent-message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Loading...");

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
    .element(screen.getByTestId("parent-message-count"))
    .toHaveTextContent("2");
});

// provideStream / injectStream context tests
it("provideStream shares stream state across child components", async () => {
  const screen = await render(ContextProviderComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
});

it("provideStream children can submit and receive messages", async () => {
  const screen = await render(ContextProviderComponent);

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
  const screen = await render(ContextProviderComponent);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("injectStream throws when used outside an injection context", () => {
  expect(() => {
    injectStream();
  }).toThrow();
});

it("headless tools - executes in browser and resumes agent automatically", async () => {
  const screen = await render(HeadlessToolComponent);

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Where am I?");

  await expect
    .element(screen.getByTestId("message-last"))
    .toHaveTextContent("Location received!");
});

it("headless tools - onHeadlessTool callback fires start and success events", async () => {
  const screen = await render(HeadlessToolComponent);

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("tool-event-0"))
    .toHaveTextContent("start:get_location");

  await expect
    .element(screen.getByTestId("tool-event-1"))
    .toHaveTextContent("success:get_location");
});

it("headless tools - propagates execute error back to agent as error payload", async () => {
  const screen = await render(HeadlessToolErrorComponent);

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("tool-event-1"))
    .toHaveTextContent("error:get_location:GPS unavailable");

  await expect
    .element(screen.getByTestId("message-last"))
    .toHaveTextContent("Location received!");
});

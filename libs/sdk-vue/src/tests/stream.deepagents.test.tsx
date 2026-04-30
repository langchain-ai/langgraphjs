import { it, expect, inject } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent, ref, watch } from "vue";
import { AIMessage } from "@langchain/core/messages";

import { useStream } from "../index.js";
import { createReactiveSubagentAccessors } from "../subagents.js";
import { DeepAgentSubagentCard } from "./components/DeepAgentSubagentCard.js";
import { DeepAgentResearcherSummary } from "./components/DeepAgentResearcherSummary.js";
import type { DeepAgentGraph } from "./fixtures/browser-fixtures.js";

const serverUrl = inject("serverUrl");

it("deep agent: subagents call tools and render args/results", async () => {
  function formatMessage(msg: Record<string, any>): string {
    if (AIMessage.isInstance(msg)) {
      return msg.tool_calls?.map(
        (tc: { name: string; args: Record<string, unknown> }) =>
          `tool_call:${tc.name}:${JSON.stringify(tc.args)}`,
      ).join(",") ?? "";
    }

    if (msg.type === "tool") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      return `tool_result:${content}`;
    }

    return typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  }

  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
      });

      return () => {
        const subagents = [...thread.subagents.value.values()].sort(
          (a: any, b: any) =>
            (a.name ?? "").localeCompare(b.name ?? ""),
        );

        return (
          <div
            data-testid="deep-agent-root"
            style={{ fontFamily: "monospace", fontSize: "13px" }}
          >
            <div data-testid="loading">
              <b>Status:</b>{" "}
              {thread.isLoading.value ? "Loading..." : "Not loading"}
            </div>
            {thread.error.value ? (
              <div data-testid="error">{String(thread.error.value)}</div>
            ) : null}
            <hr />
            <div>
              <b>Messages ({thread.messages.value.length})</b>
            </div>
            <div data-testid="root-toolcall-count">
              {thread.toolCalls.value.length}
            </div>
            <div data-testid="root-toolcall-names">
              {thread.toolCalls.value.map((tc) => tc.name).join(",")}
            </div>
            <div data-testid="messages">
              {thread.messages.value.map((msg, i) => (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  [{msg.type}] {formatMessage(msg)}
                </div>
              ))}
            </div>
            <hr />
            <div>
              <b>Subagents</b> (
              <span data-testid="subagent-count">{subagents.length}</span>)
            </div>
            {subagents.map((sub: any) => (
              <DeepAgentSubagentCard
                key={sub.id}
                stream={thread}
                subagent={sub}
              />
            ))}
            <hr />
            <button
              data-testid="submit"
              onClick={() =>
                void thread.submit({
                  messages: [{ content: "Run analysis", type: "human" }],
                })
              }
            >
              Send
            </button>
          </div>
        );
      };
    },
  });

  const screen = render(TestComponent);

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

  await expect
    .element(screen.getByTestId("subagent-researcher-messages-count"), {
      timeout: 5_000,
    })
    .not.toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-messages-count"))
    .not.toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("subagent-researcher-toolcalls-count"))
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-toolcalls-count"))
    .toHaveTextContent("1");

  await expect
    .element(screen.getByTestId("subagent-researcher-toolcall-names"))
    .toHaveTextContent("search_web");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-toolcall-names"))
    .toHaveTextContent("query_database");
  await expect
    .element(screen.getByTestId("root-toolcall-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("root-toolcall-names"))
    .toHaveTextContent(/task/);

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

it("deep agent: subagent discovery renders while subagents are still running", async () => {
  const observedGroupedStates = new Set<string>();

  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
      });

      return () => {
        const subagents = [...thread.subagents.value.values()].sort(
          (a: any, b: any) => (a.name ?? "").localeCompare(b.name ?? ""),
        );

        if (thread.isLoading.value && subagents.length > 0) {
          observedGroupedStates.add("rendered-while-loading");
        }

        for (const sub of subagents) {
          observedGroupedStates.add(
            `${sub.name}:${sub.status}:${sub.output ? "has-result" : "no-result"
            }:${thread.isLoading.value ? "loading" : "idle"}`,
          );
        }

        return (
          <div data-testid="deep-agent-by-message-root">
            <div data-testid="loading">
              {thread.isLoading.value ? "Loading..." : "Not loading"}
            </div>
            <div data-testid="messages">
              {thread.messages.value.map((msg, i) => (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  {msg.type}:{typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content)}
                </div>
              ))}
            </div>
            <div data-testid="subagent-count">{subagents.length}</div>
            <div data-testid="subagent-statuses">
              {subagents.map((sub) => `${sub.name}:${sub.status}`).join(",")}
            </div>
            <div data-testid="observed-grouped-states">
              {[...observedGroupedStates].sort().join(",")}
            </div>
            <button
              data-testid="submit"
              onClick={() =>
                void thread.submit({
                  messages: [{ content: "Run analysis", type: "human" }],
                })
              }
            >
              Send
            </button>
          </div>
        );
      };
    },
  });

  const screen = render(TestComponent);

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
    .element(screen.getByTestId("subagent-statuses"))
    .toHaveTextContent(/data-analyst:complete/);
  await expect
    .element(screen.getByTestId("subagent-statuses"))
    .toHaveTextContent(/researcher:complete/);

  const observedStates = screen.getByTestId("observed-grouped-states");
  await expect
    .element(observedStates)
    .toHaveTextContent(/rendered-while-loading/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/data-analyst:running:no-result:loading/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/researcher:running:no-result:loading/);
});

it("deep agent: retained subagent references stay reactive", async () => {
  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
      });
      const subagentVersion = ref(0);
      const reactiveSubagents = createReactiveSubagentAccessors(
        {
          getSubagent: (id: string) => thread.subagents.value.get(id),
          getSubagentsByType: (type: string) =>
            [...thread.subagents.value.values()].filter(
              (subagent) => subagent.name === type,
            ),
          getSubagentsByMessage: (messageId: string) => {
            const message = thread.messages.value.find(
              (candidate) => candidate.id === messageId,
            ) as any;
            const toolCallIds = new Set(
              (message?.tool_calls ?? []).map((toolCall: any) => toolCall.id),
            );
            return [...thread.subagents.value.values()].filter((subagent) =>
              toolCallIds.has(subagent.id),
            );
          },
        },
        subagentVersion,
      );
      const retainedSubagent = ref<any>();

      watch(
        () => thread.subagents.value,
        () => {
          subagentVersion.value += 1;
          const researcher =
            reactiveSubagents.getSubagentsByType("researcher")[0];
          if (researcher && !retainedSubagent.value) {
            retainedSubagent.value = researcher;
          }
        },
        { immediate: true },
      );

      return () => {
        const subagent = retainedSubagent.value;
        const status = subagent?.status ?? "missing";
        const output =
          typeof subagent?.output === "string"
            ? subagent.output
            : JSON.stringify(subagent?.output ?? null);

        return (
          <div data-testid="retained-subagent-root">
            <div data-testid="retained-subagent-status">{status}</div>
            <div data-testid="retained-subagent-output">{output}</div>
            <button
              data-testid="submit"
              onClick={() =>
                void thread.submit({
                  messages: [{ content: "Run analysis", type: "human" }],
                })
              }
            >
              Send
            </button>
          </div>
        );
      };
    },
  });

  const screen = render(TestComponent);

  await expect
    .element(screen.getByTestId("retained-subagent-status"))
    .toHaveTextContent("missing");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("retained-subagent-output"), {
      timeout: 30_000,
    })
    .toHaveTextContent(/Result for: test research query/);
  await expect
    .element(screen.getByTestId("retained-subagent-status"))
    .toHaveTextContent("complete");
});

it("deep agent: retained subagent summaries react to latest tool calls", async () => {
  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
      });

      return () => {
        const researcher = [...thread.subagents.value.values()].find(
          (candidate) => candidate.name === "researcher",
        );

        return (
          <div data-testid="retained-subagent-summary-root">
            {researcher ? (
              <DeepAgentResearcherSummary
                stream={thread}
                subagent={researcher}
              />
            ) : (
              <>
                <div data-testid="retained-subagent-summary-task">missing</div>
                <div data-testid="retained-subagent-summary-tool">missing</div>
                <div data-testid="retained-subagent-summary-args">{"{}"}</div>
              </>
            )}
            <button
              data-testid="submit"
              onClick={() =>
                void thread.submit({
                  messages: [{ content: "Run analysis", type: "human" }],
                })
              }
            >
              Send
            </button>
          </div>
        );
      };
    },
  });

  const screen = render(TestComponent);

  await expect
    .element(screen.getByTestId("retained-subagent-summary-tool"))
    .toHaveTextContent("missing");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("retained-subagent-summary-task"), {
      timeout: 30_000,
    })
    .toHaveTextContent("Search the web for test research query");
  await expect
    .element(screen.getByTestId("retained-subagent-summary-tool"))
    .toHaveTextContent("search_web");
  await expect
    .element(screen.getByTestId("retained-subagent-summary-args"))
    .toHaveTextContent('"query":"test research query"');
});

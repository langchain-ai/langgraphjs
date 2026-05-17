import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { DeepAgentStreamComponent } from "./components/DeepAgentStream.js";

it("deep agent: subagents render status, task input, and output", async () => {
  const screen = await render(DeepAgentStreamComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("subagent-names"))
    .toHaveTextContent(/data-analyst/);
  await expect
    .element(screen.getByTestId("subagent-names"))
    .toHaveTextContent(/researcher/);

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
    .element(screen.getByTestId("subagent-researcher-messages-count"))
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
    .element(screen.getByTestId("root-toolcall-names"))
    .toHaveTextContent(/task/);

  const messages = screen.getByTestId("messages");
  await expect.element(messages).toHaveTextContent(/Run analysis/);
});

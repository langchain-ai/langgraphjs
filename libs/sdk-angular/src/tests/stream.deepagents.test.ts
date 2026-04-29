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
    .element(screen.getByTestId("subagent-count"), { timeout: 30_000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 30_000 })
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

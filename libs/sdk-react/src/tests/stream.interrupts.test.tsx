import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { InterruptStream } from "./components/InterruptStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("surfaces the first interrupt on submit()", async () => {
  const screen = await render(<InterruptStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-prompt"))
      .toHaveTextContent("Approve the outbound action?");
    await expect
      .element(screen.getByTestId("completed"))
      .toHaveTextContent("false");
    await expect
      .element(screen.getByTestId("interrupt-id"))
      .not.toHaveTextContent("");
  } finally {
    await cleanupRender(screen);
  }
});

it("resumes an interrupt via submit({ command: { resume } })", async () => {
  const screen = await render(<InterruptStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("1");

    await screen.getByTestId("resume").click();

    await expect
      .element(screen.getByTestId("completed"))
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("decision"))
      .toHaveTextContent('"approved":true');
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("resumes an interrupt via respond()", async () => {
  const screen = await render(
    <InterruptStream apiUrl={apiUrl} useRespondMethod />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("1");

    await screen.getByTestId("resume").click();

    await expect
      .element(screen.getByTestId("completed"), { timeout: 10_000 })
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("decision"))
      .toHaveTextContent('"approved":true');
  } finally {
    await cleanupRender(screen);
  }
});

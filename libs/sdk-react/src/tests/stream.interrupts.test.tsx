import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { InterruptStream } from "./components/InterruptStream.js";
import { MultiInterruptStream } from "./components/MultiInterruptStream.js";
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

it("resumes an interrupt via respond()", async () => {
  const screen = await render(<InterruptStream apiUrl={apiUrl} />);

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
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("resumes several parallel interrupts via respondAll()", { timeout: 15_000 }, async () => {
  const screen = await render(<MultiInterruptStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("thread-interrupt-count"), {
        timeout: 10_000,
      })
      .toHaveTextContent("2");

    await screen.getByTestId("resume-all").click();

    await expect
      .element(screen.getByTestId("completed"), { timeout: 10_000 })
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("decisions"))
      .toHaveTextContent('"A":{"approved":true}');
    await expect
      .element(screen.getByTestId("decisions"))
      .toHaveTextContent('"B":{"approved":false}');
    await expect
      .element(screen.getByTestId("thread-interrupt-count"))
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

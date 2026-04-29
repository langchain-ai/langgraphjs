import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent } from "vue";

import { ContextStream } from "./components/ContextStream.js";
import { useStreamContext } from "../index.js";
import { apiUrl } from "./test-utils.js";

it("shares a stream handle across ancestor/descendant components", async () => {
  const screen = await render(ContextStream, { props: { apiUrl } });

  try {
    await expect
      .element(screen.getByTestId("child-count"))
      .toHaveTextContent("0");

    await screen.getByTestId("child-submit").click();

    await expect
      .element(screen.getByTestId("child-message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("child-message-1"))
      .toHaveTextContent("Hey");
  } finally {
    await screen.unmount();
  }
});

it("throws a descriptive error when useStreamContext is called outside provideStream", async () => {
  const Orphan = defineComponent({
    setup() {
      try {
        useStreamContext();
        return () => <div data-testid="result">no-error</div>;
      } catch (error) {
        return () => (
          <div data-testid="result">
            {error instanceof Error ? error.message : "unknown"}
          </div>
        );
      }
    },
  });

  const screen = await render(Orphan);

  try {
    await expect
      .element(screen.getByTestId("result"))
      .toHaveTextContent(
        "useStreamContext() requires a parent component to call provideStream()",
      );
  } finally {
    await screen.unmount();
  }
});

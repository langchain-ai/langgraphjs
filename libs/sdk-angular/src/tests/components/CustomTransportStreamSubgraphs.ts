import type { BaseMessage } from "langchain";
import { Component } from "@angular/core";
import type { UseStreamTransport } from "../../index.js";
import { injectStreamCustom } from "../../stream.custom.js";

type StreamState = { messages: BaseMessage[] };

/** Set from tests before rendering {@link CustomTransportStreamSubgraphsComponent}. */
export const customStreamTransportHolder: {
  stream?: UseStreamTransport<StreamState>["stream"];
} = {};

@Component({
  template: `
    <button data-testid="submit-custom-subgraphs" (click)="onClick()">
      Submit
    </button>
  `,
})
export class CustomTransportStreamSubgraphsComponent {
  stream = injectStreamCustom<StreamState>({
    transport: {
      stream: (payload) => {
        const fn = customStreamTransportHolder.stream;
        if (!fn) {
          throw new Error("customStreamTransportHolder.stream not set");
        }
        return fn(payload);
      },
    },
    threadId: null,
    onThreadId: () => {},
  });

  onClick() {
    void this.stream.submit(
      { messages: [{ type: "human", content: "Hi" }] } as any,
      { streamSubgraphs: true },
    );
  }
}

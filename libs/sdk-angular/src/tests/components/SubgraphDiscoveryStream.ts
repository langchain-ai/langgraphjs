import { Component, computed } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../inject-stream.js";
import { STREAM_CONTROLLER } from "../../use-stream.js";
import { injectMessages } from "../../selectors.js";
import type { SelectorTarget } from "../../selectors.js";
import { formatMessage } from "./format.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="root-message-count">{{ stream.messages().length }}</div>
      <div data-testid="subgraph-count">{{ subgraphs().length }}</div>
      <div data-testid="subgraph-nodes">{{ subgraphNodes() }}</div>
      <div data-testid="registry-size">{{ registrySize() }}</div>
      <div data-testid="scoped-subgraph-messages-count">
        {{ scopedMessages().length }}
      </div>
      <div data-testid="scoped-subgraph-messages">
        @for (msg of scopedMessages(); track msg.id ?? $index) {
          <span [attr.data-testid]="'scoped-subgraph-message-' + $index">
            {{ format(msg) }}
          </span>
        }
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class SubgraphDiscoveryStreamComponent {
  readonly format = formatMessage;

  readonly stream = injectStream<StreamState>({
    assistantId: "parentAgent",
    apiUrl: serverUrl,
  });

  readonly subgraphs = computed(() => [...this.stream.subgraphs().values()]);

  readonly firstSubgraph = computed<SelectorTarget>(
    () => this.subgraphs()[0] ?? null,
  );

  readonly scopedMessages = injectMessages(this.stream, this.firstSubgraph);

  subgraphNodes(): string {
    return [...this.stream.subgraphsByNode().entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, arr]) => `${node}:${arr.length}`)
      .join(",");
  }

  registrySize(): number {
    return this.stream[STREAM_CONTROLLER].registry.size;
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Call subgraph please")],
    });
  }
}

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="subgraph-count">{{ subgraphs().length }}</div>
      <div data-testid="subgraph-nodes">{{ subgraphNodes() }}</div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class EmbeddedSubgraphDiscoveryStreamComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "embeddedSubgraphAgent",
    apiUrl: serverUrl,
  });

  readonly subgraphs = computed(() => [...this.stream.subgraphs().values()]);

  subgraphNodes(): string {
    return [...this.stream.subgraphsByNode().entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, arr]) => `${node}:${arr.length}`)
      .join(",");
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Call embedded subgraph please")],
    });
  }
}

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="subgraph-count">{{ subgraphs().length }}</div>
      <div data-testid="subgraph-nodes">{{ subgraphNodes() }}</div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class WebSocketEmbeddedSubgraphDiscoveryStreamComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "embeddedSubgraphAgent",
    apiUrl: serverUrl,
    transport: "websocket",
  });

  readonly subgraphs = computed(() => [...this.stream.subgraphs().values()]);

  subgraphNodes(): string {
    return [...this.stream.subgraphsByNode().entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, arr]) => `${node}:${arr.length}`)
      .join(",");
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Call websocket subgraph please")],
    });
  }
}

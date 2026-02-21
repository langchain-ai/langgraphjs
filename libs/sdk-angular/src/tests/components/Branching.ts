import { Component } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            <div [attr.data-testid]="'content-' + $index">{{ str(msg.content) }}</div>

            @if (getBranchOptions(msg, $index); as nav) {
              <div [attr.data-testid]="'branch-nav-' + $index">
                <button
                  [attr.data-testid]="'prev-' + $index"
                  (click)="onPrev(nav.branchOptions, nav.branchIndex)"
                >
                  Previous
                </button>
                <span [attr.data-testid]="'branch-info-' + $index">
                  {{ nav.branchIndex + 1 }} / {{ nav.branchOptions.length }}
                </span>
                <button
                  [attr.data-testid]="'next-' + $index"
                  (click)="onNext(nav.branchOptions, nav.branchIndex)"
                >
                  Next
                </button>
              </div>
            }

            @if (msg.type === 'human') {
              <button
                [attr.data-testid]="'fork-' + $index"
                (click)="onFork(msg, $index)"
              >
                Fork
              </button>
            }

            @if (msg.type === 'ai') {
              <button
                [attr.data-testid]="'regenerate-' + $index"
                (click)="onRegenerate(msg, $index)"
              >
                Regenerate
              </button>
            }
          </div>
        }
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class BranchingComponent {
  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    fetchStateHistory: true,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getBranchOptions(msg: any, index: number) {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    const branchOptions = metadata?.branchOptions;
    const branch = metadata?.branch;
    if (!branchOptions || !branch) return null;
    const branchIndex = branchOptions.indexOf(branch);
    return { branchOptions, branchIndex };
  }

  onPrev(branchOptions: string[], branchIndex: number) {
    const prevBranch = branchOptions[branchIndex - 1];
    if (prevBranch) this.stream.setBranch(prevBranch);
  }

  onNext(branchOptions: string[], branchIndex: number) {
    const nextBranch = branchOptions[branchIndex + 1];
    if (nextBranch) this.stream.setBranch(nextBranch);
  }

  onFork(msg: any, index: number) {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    const checkpoint =
      metadata?.firstSeenState?.parent_checkpoint ?? undefined;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    void this.stream.submit(
      {
        messages: [{ type: "human", content: `Fork: ${text}` }],
      } as any,
      { checkpoint }
    );
  }

  onRegenerate(msg: any, index: number) {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    const checkpoint =
      metadata?.firstSeenState?.parent_checkpoint ?? undefined;
    void this.stream.submit(undefined as any, { checkpoint });
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }
}

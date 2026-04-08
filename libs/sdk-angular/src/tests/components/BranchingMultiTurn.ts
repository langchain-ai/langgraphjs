import { Component } from "@angular/core";
import { inject } from "vitest";
import { injectStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  template: `
    <div>
      <div data-testid="messages">
        @for (msg of stream.messages(); track msg.id ?? $index) {
          <div [attr.data-testid]="'message-' + $index">
            <div [attr.data-testid]="'content-' + $index">
              {{ str(msg.content) }}
            </div>
            <div [attr.data-testid]="'fork-parent-' + $index">
              {{ getForkParent(msg, $index) }}
            </div>

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

            @if (msg.type === "human") {
              <button
                [attr.data-testid]="'fork-' + $index"
                (click)="onFork(msg, $index)"
              >
                Fork
              </button>
            }
            @if (msg.type === "ai") {
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
      <button data-testid="submit-root" (click)="onSubmitRoot()">Send Root</button>
      <button data-testid="submit-follow-up" (click)="onSubmitFollowUp()">
        Send Follow Up
      </button>
    </div>
  `,
})
export class BranchingMultiTurnComponent {
  stream = injectStream({
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

  getForkParent(msg: any, index: number) {
    return (
      this.stream.getMessagesMetadata(msg, index)?.forkParentCheckpoint
        ?.checkpoint_id ?? ""
    );
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
      metadata?.forkParentCheckpoint ??
      metadata?.firstSeenState?.parent_checkpoint ??
      undefined;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    void this.stream.submit(
      {
        messages: [{ type: "human", content: `Fork: ${text}` }],
      } as any,
      { checkpoint },
    );
  }

  onRegenerate(msg: any, index: number) {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    const checkpoint =
      metadata?.forkParentCheckpoint ??
      metadata?.firstSeenState?.parent_checkpoint ??
      undefined;
    void this.stream.submit(undefined as any, { checkpoint });
  }

  onSubmitRoot() {
    void this.stream.submit({
      messages: [{ content: "Hello", type: "human" }],
    } as any);
  }

  onSubmitFollowUp() {
    void this.stream.submit({
      messages: [{ content: "Follow up", type: "human" }],
    } as any);
  }
}

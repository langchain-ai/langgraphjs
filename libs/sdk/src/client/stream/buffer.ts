import type { Event } from "@langchain/protocol";
import type { SubscribeParams } from "@langchain/protocol";

import { matchesSubscription } from "./subscription.js";

/**
 * Bounded in-memory event buffer used to replay recent events to new or
 * reconnected subscriptions.
 */
export class EventBuffer {
  private readonly maxSize: number;
  private events: Event[] = [];

  /**
   * Creates a buffer that retains up to `maxSize` events.
   *
   * @param maxSize - Maximum number of events to retain before evicting the
   * oldest entries.
   */
  constructor(maxSize = 512) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * Appends an event and evicts the oldest one when the buffer is full.
   *
   * @param event - Event to append to the replay buffer.
   */
  push(event: Event): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  /**
   * Replays buffered events that match a subscription, optionally starting
   * after a previously acknowledged event id.
   *
   * @param filter - Subscription definition used to filter buffered events.
   * @param afterEventId - Last event id already observed by the caller.
   */
  replay(filter: SubscribeParams, afterEventId?: string): Event[] {
    const snapshot =
      afterEventId === undefined
        ? this.events
        : (() => {
            const index = this.events.findIndex(
              (event) => event.event_id === afterEventId
            );
            return index >= 0 ? this.events.slice(index + 1) : this.events;
          })();

    return snapshot.filter((event) => matchesSubscription(event, filter));
  }
}

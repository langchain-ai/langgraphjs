import type { Event } from "@langchain/protocol";
import type { SubscribeParams } from "@langchain/protocol";

import { matchesSubscription } from "./subscription.js";

export class EventBuffer {
  private readonly maxSize: number;
  private events: Event[] = [];

  constructor(maxSize = 512) {
    this.maxSize = Math.max(1, maxSize);
  }

  push(event: Event): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  replay(filter: SubscribeParams, afterEventId?: string): Event[] {
    const snapshot =
      afterEventId === undefined
        ? this.events
        : (() => {
            const index = this.events.findIndex((event) => event.eventId === afterEventId);
            return index >= 0 ? this.events.slice(index + 1) : this.events;
          })();

    return snapshot.filter((event) => matchesSubscription(event, filter));
  }
}

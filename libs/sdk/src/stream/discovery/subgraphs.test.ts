import { describe, expect, it } from "vitest";
import type { Event, LifecycleEvent } from "@langchain/protocol";

import { SubgraphDiscovery } from "./subgraphs.js";

function lifecycleEvent(
  namespace: readonly string[],
  event: "started" | "completed",
  seq = 1
): Event {
  return {
    type: "event",
    method: "lifecycle",
    seq,
    params: {
      namespace,
      timestamp: Date.now(),
      data: { event },
    },
  } as LifecycleEvent & Event;
}

describe("SubgraphDiscovery", () => {
  it("promotes a host namespace when a deeper namespace is observed", () => {
    const discovery = new SubgraphDiscovery();
    const host = ["classify:u1"] as const;
    const inner = ["classify:u1", "inner:u2"] as const;

    discovery.push(lifecycleEvent(host, "started", 1));
    discovery.push(lifecycleEvent(inner, "started", 2));

    expect([...discovery.snapshot.values()]).toMatchObject([
      { nodeName: "classify", status: "running" },
    ]);
  });

  it("reset clears committed subgraph maps", () => {
    const discovery = new SubgraphDiscovery();
    discovery.push(lifecycleEvent(["classify:u1"], "started", 1));
    discovery.push(
      lifecycleEvent(["classify:u1", "inner:u2"], "started", 2)
    );
    expect(discovery.snapshot.size).toBeGreaterThan(0);

    discovery.reset();

    expect(discovery.snapshot.size).toBe(0);
    expect(discovery.byNodeSnapshot.size).toBe(0);
  });
});

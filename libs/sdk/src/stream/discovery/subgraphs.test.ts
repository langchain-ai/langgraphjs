import { describe, expect, it } from "vitest";
import type { Event, LifecycleEvent, ValuesEvent } from "@langchain/protocol";

import { SubgraphDiscovery } from "./subgraphs.js";

function lifecycleEvent(
  namespace: readonly string[],
  event: "started" | "completed" | "failed",
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

function valuesEvent(
  namespace: readonly string[],
  data: Record<string, unknown> = {},
  seq = 1
): Event {
  return {
    type: "event",
    method: "values",
    seq,
    params: {
      namespace,
      timestamp: Date.now(),
      data,
    },
  } as ValuesEvent & Event;
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

  it("does not resurrect a completed subgraph from a late values snapshot", () => {
    // The content pump (values) and lifecycle watcher (lifecycle) are
    // independent streams, so a host namespace's final values snapshot
    // can be delivered AFTER its terminal lifecycle event. A late values
    // event must not downgrade the node back to "running".
    const discovery = new SubgraphDiscovery();
    const host = ["classify:u1"] as const;
    const inner = ["classify:u1", "run:u2"] as const;

    discovery.push(lifecycleEvent(host, "started", 1));
    discovery.push(valuesEvent(host, {}, 2));
    discovery.push(lifecycleEvent(inner, "started", 3));
    discovery.push(lifecycleEvent(host, "completed", 4));
    // Reordered: the host's final values snapshot lands after completed.
    discovery.push(valuesEvent(host, {}, 5));

    expect([...discovery.snapshot.values()]).toMatchObject([
      { nodeName: "classify", status: "complete" },
    ]);
  });

  it("does not resurrect a failed subgraph from a late values snapshot", () => {
    const discovery = new SubgraphDiscovery();
    const host = ["classify:u1"] as const;
    const inner = ["classify:u1", "run:u2"] as const;

    discovery.push(lifecycleEvent(host, "started", 1));
    discovery.push(lifecycleEvent(inner, "started", 2));
    discovery.push(lifecycleEvent(host, "failed", 3));
    discovery.push(valuesEvent(host, {}, 4));

    expect([...discovery.snapshot.values()]).toMatchObject([
      { nodeName: "classify", status: "error" },
    ]);
  });

  it("seedFromHistory rebuilds store and byNodeStore", () => {
    const discovery = new SubgraphDiscovery();
    discovery.seedFromHistory([
      { namespace: ["research:u1"], status: "complete" },
      { namespace: ["research:u2"], status: "complete" },
      { namespace: ["writer:u3"], status: "running" },
    ]);

    expect(discovery.snapshot.size).toBe(3);
    expect(discovery.byNodeSnapshot.get("research")).toHaveLength(2);
    expect(discovery.snapshot.get("research:u1")).toMatchObject({
      nodeName: "research",
      namespace: ["research:u1"],
    });
    expect([...discovery.snapshot.values()].map((s) => s.status).sort()).toEqual(
      ["complete", "complete", "running"]
    );
  });

  it("seedFromHistory does not downgrade a terminal entry", () => {
    const discovery = new SubgraphDiscovery();
    const host = ["classify:u1"] as const;
    const inner = ["classify:u1", "inner:u2"] as const;
    discovery.push(lifecycleEvent(host, "started", 1));
    discovery.push(lifecycleEvent(inner, "started", 2));
    discovery.push(lifecycleEvent(host, "completed", 3));
    expect([...discovery.snapshot.values()][0].status).toBe("complete");

    // A stale "running" from history must not resurrect it.
    discovery.seedFromHistory([
      { namespace: ["classify:u1"], status: "running" },
    ]);
    expect([...discovery.snapshot.values()][0].status).toBe("complete");
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

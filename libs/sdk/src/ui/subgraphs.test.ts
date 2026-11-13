import { describe, expect, it } from "vitest";

import type { ChannelEvent } from "./channels.js";
import { SubgraphDiscovery } from "./subgraphs.js";

function lifecycleEvent(
  namespace: readonly string[],
  event: "started" | "completed" | "failed"
): ChannelEvent {
  return {
    method: "lifecycle",
    params: {
      namespace: [...namespace],
      timestamp: Date.now(),
      data: { event },
    },
  };
}

function valuesEvent(namespace: readonly string[]): ChannelEvent {
  return {
    method: "values",
    params: {
      namespace: [...namespace],
      timestamp: Date.now(),
      data: {},
    },
  };
}

describe("SubgraphDiscovery", () => {
  it("promotes a host namespace when a deeper namespace is observed", () => {
    const discovery = new SubgraphDiscovery();
    const host = ["classify:u1"] as const;
    const inner = ["classify:u1", "inner:u2"] as const;

    discovery.push(lifecycleEvent(host, "started"));
    discovery.push(lifecycleEvent(inner, "started"));

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

    discovery.push(lifecycleEvent(host, "started"));
    discovery.push(valuesEvent(host));
    discovery.push(lifecycleEvent(inner, "started"));
    discovery.push(lifecycleEvent(host, "completed"));
    // Reordered: the host's final values snapshot lands after completed.
    discovery.push(valuesEvent(host));

    expect([...discovery.snapshot.values()]).toMatchObject([
      { nodeName: "classify", status: "complete" },
    ]);
  });

  it("does not resurrect a failed subgraph from a late values snapshot", () => {
    const discovery = new SubgraphDiscovery();
    const host = ["classify:u1"] as const;
    const inner = ["classify:u1", "run:u2"] as const;

    discovery.push(lifecycleEvent(host, "started"));
    discovery.push(lifecycleEvent(inner, "started"));
    discovery.push(lifecycleEvent(host, "failed"));
    discovery.push(valuesEvent(host));

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
    discovery.push(lifecycleEvent(host, "started"));
    discovery.push(lifecycleEvent(inner, "started"));
    discovery.push(lifecycleEvent(host, "completed"));
    expect([...discovery.snapshot.values()][0].status).toBe("complete");

    // A stale "running" from history must not resurrect it.
    discovery.seedFromHistory([
      { namespace: ["classify:u1"], status: "running" },
    ]);
    expect([...discovery.snapshot.values()][0].status).toBe("complete");
  });

  it("ignores a lifecycle event without data", () => {
    const discovery = new SubgraphDiscovery();
    discovery.push({
      method: "lifecycle",
      params: { namespace: ["classify:u1"], data: null },
    });

    expect(discovery.snapshot.size).toBe(0);
  });

  it("reset clears committed subgraph maps", () => {
    const discovery = new SubgraphDiscovery();
    discovery.push(lifecycleEvent(["classify:u1"], "started"));
    discovery.push(lifecycleEvent(["classify:u1", "inner:u2"], "started"));
    expect(discovery.snapshot.size).toBeGreaterThan(0);

    discovery.reset();

    expect(discovery.snapshot.size).toBe(0);
    expect(discovery.byNodeSnapshot.size).toBe(0);
  });
});

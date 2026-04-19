/**
 * Root-scoped subgraph discovery.
 *
 * Watches namespaced `lifecycle` events on the root subscription and
 * assembles two views of the subgraph set:
 *
 *  - {@link SubgraphMap}: `Map<namespaceKey, SubgraphDiscoverySnapshot>`,
 *    the canonical identity-keyed view consumed by the channel
 *    registry and selector hooks.
 *  - {@link SubgraphByNodeMap}: `Map<nodeName, readonly
 *    SubgraphDiscoverySnapshot[]>`, a convenience index so callers
 *    can look up subgraphs by the graph node that produced them
 *    (`addNode("visualizer_0", …)`) without parsing namespaces.
 *    Arrays preserve insertion order, which matters for parallel
 *    fan-outs that share a node name.
 */
import type { Event, LifecycleEvent } from "@langchain/protocol";
import { StreamStore } from "../store.js";
import type { SubgraphDiscoverySnapshot } from "../types.js";

export type SubgraphMap = ReadonlyMap<string, SubgraphDiscoverySnapshot>;
export type SubgraphByNodeMap = ReadonlyMap<
  string,
  readonly SubgraphDiscoverySnapshot[]
>;

interface MutableSubgraph {
  id: string;
  namespace: readonly string[];
  nodeName: string;
  status: "running" | "complete" | "error";
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * LangGraph namespaces a node invocation as `<node_name>:<uuid>`
 * (parallel fan-outs share `<node_name>` as a prefix but each get a
 * fresh uuid). Extract the node-name half so callers can key
 * discovery lookups on names they wrote in `addNode(...)`.
 */
function parseNodeName(segment: string): string {
  const colon = segment.indexOf(":");
  return colon === -1 ? segment : segment.slice(0, colon);
}

export class SubgraphDiscovery {
  readonly store = new StreamStore<SubgraphMap>(new Map());
  readonly byNodeStore = new StreamStore<SubgraphByNodeMap>(new Map());
  #map = new Map<string, MutableSubgraph>();

  /** Feed a single root event. Non-`lifecycle` events are ignored. */
  push(event: Event): void {
    if (event.method !== "lifecycle") return;
    const lifecycle = event as LifecycleEvent;
    const namespace = lifecycle.params.namespace;
    // Root lifecycle events describe the main run; subgraph discovery
    // only cares about namespaced lifecycle events.
    if (namespace.length === 0) return;
    const id = namespace.join("\u0000");
    const data = lifecycle.params.data as { event?: string };
    const lastSegment = namespace[namespace.length - 1] ?? "";
    const nodeName = parseNodeName(lastSegment);

    if (data.event === "started" || data.event === "started-subgraph") {
      if (!this.#map.has(id)) {
        this.#map.set(id, {
          id,
          namespace: [...namespace],
          nodeName,
          status: "running",
          startedAt: new Date(),
          completedAt: null,
        });
        this.#commit();
      }
      return;
    }

    const entry = this.#map.get(id);
    if (entry == null) {
      // Synthesize a record for subgraphs whose `started` we missed
      // (common when a late subscription attaches to a running session).
      if (
        data.event === "completed" ||
        data.event === "failed" ||
        data.event === "interrupted"
      ) {
        this.#map.set(id, {
          id,
          namespace: [...namespace],
          nodeName,
          status: data.event === "failed" ? "error" : "complete",
          startedAt: new Date(),
          completedAt: new Date(),
        });
        this.#commit();
      }
      return;
    }

    if (data.event === "completed" || data.event === "interrupted") {
      entry.status = "complete";
      entry.completedAt = new Date();
      this.#commit();
    } else if (data.event === "failed") {
      entry.status = "error";
      entry.completedAt = new Date();
      this.#commit();
    }
  }

  get snapshot(): SubgraphMap {
    return this.store.getSnapshot();
  }

  get byNodeSnapshot(): SubgraphByNodeMap {
    return this.byNodeStore.getSnapshot();
  }

  #commit(): void {
    const snapshots: SubgraphDiscoverySnapshot[] = [...this.#map.values()].map(
      (entry) => ({ ...entry })
    );

    this.store.setValue(new Map(snapshots.map((s) => [s.id, s])));

    const byNode = new Map<string, SubgraphDiscoverySnapshot[]>();
    for (const snap of snapshots) {
      const bucket = byNode.get(snap.nodeName);
      if (bucket == null) byNode.set(snap.nodeName, [snap]);
      else bucket.push(snap);
    }
    this.byNodeStore.setValue(byNode);
  }
}

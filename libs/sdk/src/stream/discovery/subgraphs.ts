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
 *
 * # What counts as a subgraph
 *
 * The server emits a namespaced `lifecycle` event for every node
 * invocation — a plain function node (`orchestrator`) and a subgraph
 * host (`research`) look identical on the wire. We classify a
 * namespace as a subgraph iff at least one strictly-deeper namespace
 * has been observed with it as a prefix. Concretely, given a stream
 * whose lifecycle events hit the namespaces
 *
 *   `["orchestrator:u1"]`
 *   `["research:u2"]`
 *   `["research:u2", "researcher:u3"]`
 *   `["research:u2", "tools:u4"]`
 *   `["writer:u5"]`
 *
 * only `["research:u2"]` is promoted — it's the only namespace that
 * hosts deeper executions. `orchestrator` and `writer` are plain
 * function-node leaves; the `researcher` / `tools` entries are the
 * subgraph's internal nodes, not subgraphs in their own right.
 *
 * Promotion is monotonic (a namespace never loses subgraph status)
 * and retroactive: a namespace whose own `started` event arrived
 * before any descendant is promoted later when the first descendant
 * event lands. Latency is bounded by the gap between a parent node
 * entering and its first inner node materializing — typically tens
 * of milliseconds.
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

  /**
   * Latest known status for every namespaced lifecycle event we have
   * ever observed. A shadow entry is NOT necessarily a subgraph —
   * it is only projected into the committed stores once the same
   * namespace also appears in {@link #promoted}.
   */
  #shadow = new Map<string, MutableSubgraph>();

  /**
   * Namespaces that have been observed as a strict prefix of a
   * deeper namespace and are therefore confirmed subgraph hosts.
   * Insertion order is preserved and becomes the iteration order
   * of the committed snapshot maps.
   */
  #promoted = new Set<string>();

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

    let touched = false;

    // Promote every strict ancestor the first time we see it as a
    // prefix. The ancestor may or may not yet have a shadow entry;
    // #commit() tolerates either case.
    for (let depth = 1; depth < namespace.length; depth += 1) {
      const ancestorId = namespace.slice(0, depth).join("\u0000");
      if (!this.#promoted.has(ancestorId)) {
        this.#promoted.add(ancestorId);
        if (this.#shadow.has(ancestorId)) touched = true;
      }
    }

    // Update shadow status for this namespace itself.
    if (data.event === "started") {
      if (!this.#shadow.has(id)) {
        this.#shadow.set(id, {
          id,
          namespace: [...namespace],
          nodeName,
          status: "running",
          startedAt: new Date(),
          completedAt: null,
        });
        if (this.#promoted.has(id)) touched = true;
      }
    } else if (
      data.event === "completed" ||
      data.event === "interrupted" ||
      data.event === "failed"
    ) {
      // Synthesize a shadow entry if we missed the `started` event
      // (common when a late subscription attaches to a running run).
      const entry = this.#ensureShadow(id, namespace, nodeName);
      if (data.event === "failed") {
        entry.status = "error";
      } else {
        entry.status = "complete";
      }
      entry.completedAt = new Date();
      if (this.#promoted.has(id)) touched = true;
    }

    if (touched) this.#commit();
  }

  get snapshot(): SubgraphMap {
    return this.store.getSnapshot();
  }

  get byNodeSnapshot(): SubgraphByNodeMap {
    return this.byNodeStore.getSnapshot();
  }

  #ensureShadow(
    id: string,
    namespace: readonly string[],
    nodeName: string
  ): MutableSubgraph {
    let entry = this.#shadow.get(id);
    if (entry == null) {
      entry = {
        id,
        namespace: [...namespace],
        nodeName,
        status: "running",
        startedAt: new Date(),
        completedAt: null,
      };
      this.#shadow.set(id, entry);
    }
    return entry;
  }

  #commit(): void {
    const snapshots: SubgraphDiscoverySnapshot[] = [];
    for (const id of this.#promoted) {
      const entry = this.#shadow.get(id);
      // A namespace can be promoted before its own lifecycle event
      // arrives if descendant events outpace the prefix event. Skip
      // until the shadow entry lands; the next push() promoting or
      // updating this namespace will re-commit.
      if (entry == null) continue;
      snapshots.push({ ...entry });
    }

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

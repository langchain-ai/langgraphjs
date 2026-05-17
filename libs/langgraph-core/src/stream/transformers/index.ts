/**
 * Built-in graph-level stream transformers.
 *
 * These transformers are registered automatically for every graph run:
 *
 *   SubgraphDiscoveryTransformer - materializes SubgraphRunStream handles
 *                                  and announces them on the mux
 *                                  `_discoveries` log.
 *   LifecycleTransformer - synthesizes lifecycle status events.
 *   ValuesTransformer    - captures values events and resolves run.output.
 *   MessagesTransformer  - groups messages events into ChatModelStream lifecycles.
 */

export {
  createLifecycleTransformer,
  filterLifecycleEntries,
  type LifecycleProjection,
} from "./lifecycle.js";
export { createMessagesTransformer } from "./messages.js";
export {
  createSubgraphDiscoveryTransformer,
  filterSubgraphHandles,
  type SubgraphDiscoveryProjection,
  type SubgraphDiscoveryTransformerOptions,
} from "./subgraphs.js";
export { createValuesTransformer } from "./values.js";
export type {
  LifecycleEntry,
  LifecycleTransformerOptions,
  MessagesTransformerProjection,
  ValuesTransformerProjection,
} from "./types.js";

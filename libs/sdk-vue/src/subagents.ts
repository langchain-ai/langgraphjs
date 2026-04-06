import type { Ref } from "vue";

type SubagentLike = {
  id: string;
};

type SubagentAccessors<TSubagent extends SubagentLike> = {
  getSubagent: (toolCallId: string) => TSubagent | undefined;
  getSubagentsByType: (type: string) => TSubagent[];
  getSubagentsByMessage: (messageId: string) => TSubagent[];
};

/**
 * Create stable proxy objects for subagents so retained references stay in sync
 * with the latest orchestrator snapshot while still participating in Vue
 * dependency tracking through the provided version ref.
 */
export function createReactiveSubagentAccessors<TSubagent extends SubagentLike>(
  accessors: SubagentAccessors<TSubagent>,
  version: Ref<number>
) {
  const subagentCache = new Map<string, TSubagent>();

  const getCachedSubagent = (toolCallId: string): TSubagent | undefined => {
    const current = accessors.getSubagent(toolCallId);
    if (!current) {
      subagentCache.delete(toolCallId);
      return undefined;
    }

    let cached = subagentCache.get(toolCallId);
    if (!cached) {
      cached = new Proxy({ id: toolCallId } as TSubagent, {
        get(_target, prop, receiver) {
          void version.value;
          const latest = accessors.getSubagent(toolCallId);
          if (!latest) return undefined;

          const value = Reflect.get(latest as object, prop, receiver);
          return typeof value === "function" ? value.bind(latest) : value;
        },
        has(_target, prop) {
          const latest = accessors.getSubagent(toolCallId);
          return latest ? prop in (latest as object) : false;
        },
        ownKeys() {
          void version.value;
          const latest = accessors.getSubagent(toolCallId);
          return latest ? Reflect.ownKeys(latest as object) : [];
        },
        getOwnPropertyDescriptor(_target, prop) {
          return {
            configurable: true,
            enumerable: true,
            get() {
              void version.value;
              const latest = accessors.getSubagent(toolCallId);
              if (!latest) return undefined;
              return Reflect.get(latest as object, prop);
            },
          };
        },
      });
      subagentCache.set(toolCallId, cached);
    }

    return cached;
  };

  const mapSubagents = (subagents: Map<string, TSubagent>) => {
    const nextIds = new Set(subagents.keys());
    for (const toolCallId of subagentCache.keys()) {
      if (!nextIds.has(toolCallId)) {
        subagentCache.delete(toolCallId);
      }
    }

    return new Map(
      [...subagents.keys()]
        .map((toolCallId) => {
          const cached = getCachedSubagent(toolCallId);
          return cached ? ([toolCallId, cached] as const) : undefined;
        })
        .filter((entry): entry is readonly [string, TSubagent] => entry != null)
    );
  };

  const mapActiveSubagents = (subagents: readonly TSubagent[]) =>
    subagents
      .map((subagent) => getCachedSubagent(subagent.id))
      .filter((subagent): subagent is TSubagent => subagent != null);

  return {
    mapSubagents,
    mapActiveSubagents,
    getSubagent: getCachedSubagent,
    getSubagentsByType(type: string): TSubagent[] {
      void version.value;
      return accessors
        .getSubagentsByType(type)
        .map((subagent) => getCachedSubagent(subagent.id))
        .filter((subagent): subagent is TSubagent => subagent != null);
    },
    getSubagentsByMessage(messageId: string): TSubagent[] {
      void version.value;
      return accessors
        .getSubagentsByMessage(messageId)
        .map((subagent) => getCachedSubagent(subagent.id))
        .filter((subagent): subagent is TSubagent => subagent != null);
    },
  };
}

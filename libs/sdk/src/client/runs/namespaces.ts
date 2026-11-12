const STREAM_MODES = new Set([
  "values",
  "updates",
  "checkpoints",
  "tasks",
  "debug",
  "messages",
  "custom",
  "events",
  "tools",
  "lifecycle",
]);

const SUBAGENT_SEGMENT = "tools:";

/**
 * Which events a stream that asked for `streamNamespaces` keeps, by the Agent
 * Server's own rule, so a server that ignores the param gives the same
 * events. A conversation is a `|`-joined namespace (`""` is the root graph):
 * the graph output at or below it, except below a subagent it starts. A
 * subgraph's lifecycle event shows in every conversation above it. Events
 * about the whole run always pass.
 */
export function inNamespaces(
  namespaces: readonly string[] | undefined
): ((part: { event: string; data: unknown }) => boolean) | undefined {
  if (namespaces == null || namespaces.length === 0) return undefined;
  return ({ event, data }) => {
    // A too_large gap stands in for the event it replaced.
    const name =
      event === "gap"
        ? (data as { mode?: string } | null)?.mode || event
        : event;
    const bar = name.indexOf("|");
    const base = bar === -1 ? name : name.slice(0, bar);
    const namespace = bar === -1 ? "" : name.slice(bar + 1);
    if (!isGraphOutput(base)) return true;
    return namespaces.some((conversation) => {
      const rest = below(namespace, conversation);
      if (rest === undefined) return false;
      return base === "lifecycle" ? rest !== "" : !entersSubagent(rest);
    });
  };
}

function isGraphOutput(base: string): boolean {
  // Protocol-v2 runs name a custom channel's events `custom:<name>`, and
  // legacy `messages/*` events carry no namespace, so they count as root.
  return STREAM_MODES.has(base.split(":")[0]) || base.startsWith("messages/");
}

/** The segments of `namespace` below `prefix`, or `undefined` if it isn't there. */
function below(namespace: string, prefix: string): string | undefined {
  if (prefix === "") return namespace;
  if (namespace === prefix) return "";
  if (namespace.startsWith(prefix) && namespace[prefix.length] === "|") {
    return namespace.slice(prefix.length + 1);
  }
  return undefined;
}

function entersSubagent(rest: string): boolean {
  return (
    rest.startsWith(SUBAGENT_SEGMENT) || rest.includes(`|${SUBAGENT_SEGMENT}`)
  );
}

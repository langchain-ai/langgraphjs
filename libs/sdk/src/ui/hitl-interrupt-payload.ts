/**
 * Human-in-the-loop interrupt values from the LangGraph API may use
 * snake_case (Python server) while JS clients and LangChain types expect
 * camelCase. Normalize known HITL fields on interrupt payloads at read time.
 */

/**
 * Copy a plain object, drop `snake`, and ensure `camel` is set from camel ?? snake.
 */
function aliasSnakeToCamel(
  item: unknown,
  camel: string,
  snake: string,
): unknown {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }
  const o = item as Record<string, unknown>;
  const merged = o[camel] ?? o[snake];
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === snake) continue;
    next[k] = v;
  }
  if (merged !== undefined) next[camel] = merged;
  return next;
}

function mapArrayAlias(raw: unknown, camel: string, snake: string): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item) => aliasSnakeToCamel(item, camel, snake));
}

/**
 * If `value` looks like a HITL request object from the Python API, rewrite
 * snake_case keys to the camelCase shape used by JS / LangChain.
 */
export function normalizeHitlInterruptPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeHitlInterruptPayload(v));
  }
  const obj = value as Record<string, unknown>;
  const isHitlLike =
    "action_requests" in obj ||
    "actionRequests" in obj ||
    "review_configs" in obj ||
    "reviewConfigs" in obj;
  if (!isHitlLike) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (
      k === "action_requests" ||
      k === "actionRequests" ||
      k === "review_configs" ||
      k === "reviewConfigs"
    ) {
      continue;
    }
    next[k] = v;
  }

  const actionRequestsRaw = obj.actionRequests ?? obj.action_requests;
  if (actionRequestsRaw !== undefined) {
    next.actionRequests = mapArrayAlias(
      actionRequestsRaw,
      "name",
      "action_name",
    );
  }
  const reviewConfigsRaw = obj.reviewConfigs ?? obj.review_configs;
  if (reviewConfigsRaw !== undefined) {
    next.reviewConfigs = mapArrayAlias(
      reviewConfigsRaw,
      "allowedDecisions",
      "allowed_decisions",
    );
  }
  return next;
}

import type { Namespace } from "../types.mjs";
import {
  type ProtocolCompatibleMessageMetadata,
  type ProtocolMetadataScalar,
  isRecord,
} from "./internal-types.mjs";

const PROTOCOL_METADATA_KEY_MAP = {
  provider: ["provider", "ls_provider"],
  model: ["model", "model_name", "ls_model_name"],
  modelType: ["modelType", "model_type", "ls_model_type"],
  runId: ["runId", "run_id"],
  threadId: ["threadId", "thread_id"],
  systemFingerprint: ["systemFingerprint", "system_fingerprint"],
  serviceTier: ["serviceTier", "service_tier"],
} as const satisfies Record<string, readonly string[]>;

const PROTOCOL_METADATA_SOURCE_KEYS = new Set<string>(
  Object.values(PROTOCOL_METADATA_KEY_MAP).flat()
);

const PROTOCOL_METADATA_EXCLUDED_KEYS = new Set<string>([
  "assistant_id",
  "checkpoint_ns",
  "created_by",
  "graph_id",
  "langgraph_api_url",
  "langgraph_checkpoint_ns",
  "langgraph_host",
  "langgraph_node",
  "langgraph_path",
  "langgraph_plan",
  "langgraph_step",
  "langgraph_triggers",
  "langgraph_version",
  "ls_integration",
  "run_attempt",
  "tags",
  "versions",
  "__pregel_task_id",
]);

/**
 * Checks whether a metadata field can be sent as-is in protocol events.
 *
 * @param value - Candidate metadata value.
 * @returns Whether the value is a supported scalar.
 */
export const isMetadataScalar = (
  value: unknown
): value is ProtocolMetadataScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/**
 * Extracts concise protocol-facing message metadata from a raw payload.
 *
 * @param value - Message-like payload or metadata wrapper.
 * @returns Normalized protocol metadata when at least one supported field
 * exists.
 */
export const toProtocolMessageMetadata = (
  value: unknown
): ProtocolCompatibleMessageMetadata | undefined => {
  if (!isRecord(value)) return undefined;

  const metadata = isRecord(value.metadata) ? value.metadata : value;
  const concise: ProtocolCompatibleMessageMetadata = {};

  for (const [targetKey, sourceKeys] of Object.entries(
    PROTOCOL_METADATA_KEY_MAP
  )) {
    const mappedValue = sourceKeys
      .map((sourceKey) => metadata[sourceKey])
      .find((candidate) => isMetadataScalar(candidate));
    if (mappedValue !== undefined) {
      concise[targetKey] = mappedValue;
    }
  }

  for (const [key, rawValue] of Object.entries(metadata)) {
    if (
      key in PROTOCOL_METADATA_KEY_MAP ||
      PROTOCOL_METADATA_SOURCE_KEYS.has(key) ||
      PROTOCOL_METADATA_EXCLUDED_KEYS.has(key) ||
      key.startsWith("langgraph_") ||
      key.startsWith("__pregel_") ||
      key.startsWith("checkpoint_")
    ) {
      continue;
    }

    if (isMetadataScalar(rawValue)) {
      concise[key] = rawValue;
    }
  }

  return Object.keys(concise).length > 0 ? concise : undefined;
};

/**
 * Derives a namespace from checkpoint metadata attached to a message payload.
 *
 * @param value - Message-like payload or metadata wrapper.
 * @returns Namespace segments when checkpoint metadata is present.
 */
export const toProtocolMessageNamespace = (
  value: unknown
): Namespace | undefined => {
  if (!isRecord(value)) return undefined;

  const metadata = isRecord(value.metadata) ? value.metadata : value;
  const checkpointNs =
    typeof metadata.langgraph_checkpoint_ns === "string"
      ? metadata.langgraph_checkpoint_ns
      : typeof metadata.checkpoint_ns === "string"
        ? metadata.checkpoint_ns
        : undefined;

  if (!checkpointNs) return undefined;

  return checkpointNs.split("|").filter((segment) => segment.length > 0);
};

// Copyright (c) 2026, Oracle and/or its affiliates.
import { createHash } from "node:crypto";
import type { IndexConfig } from "@langchain/langgraph-checkpoint";

import { ORACLE_VECTOR_MAX_DIMENSIONS } from "./constants.js";
import { generatedIdentifier, validateIdentifier } from "../identifiers.js";

/**
 * Oracle AI Vector Search configuration for {@link OracleStore}.
 *
 * The property names mirror the Python `langgraph-oracledb` package exactly
 * (`index_type`, `distance_metric`, `efconstruction`, ...). They are not just
 * an API surface: the same values are hashed into the table suffix and are
 * persisted in the shared `STORE_CONFIGS` table, so a Python and a JavaScript
 * store only resolve to the same tables when both spell them the same way.
 */
export const ORACLE_VECTOR_DISTANCE_METRICS = [
  "COSINE",
  "EUCLIDEAN",
  "DOT",
] as const;

export type OracleVectorDistanceMetric =
  (typeof ORACLE_VECTOR_DISTANCE_METRICS)[number];

/** HNSW (Hierarchical Navigable Small World) index configuration. */
export interface OracleHNSWIndexTypeConfig {
  type?: "hnsw";
  /** Maximum number of connections per node (2-2048). */
  neighbors?: number;
  /** Size of the dynamic candidate list during construction (1-65535). */
  efconstruction?: number;
  distance_metric?:
    | OracleVectorDistanceMetric
    | Lowercase<OracleVectorDistanceMetric>;
}

/** IVF (Inverted File) index configuration. */
export interface OracleIVFIndexTypeConfig {
  type: "ivf";
  /** Number of partitions / clusters (1-10000000). */
  neighbor_partitions?: number;
  samples_per_partition?: number;
  min_vectors_per_partition?: number;
  distance_metric?:
    | OracleVectorDistanceMetric
    | Lowercase<OracleVectorDistanceMetric>;
}

export type OracleIndexTypeConfig =
  | OracleHNSWIndexTypeConfig
  | OracleIVFIndexTypeConfig;

/**
 * `IndexConfig` extended with the Oracle AI Vector Search options.
 *
 * Changing any of these values changes the derived table suffix, which gives
 * each incompatible vector configuration its own isolated set of tables.
 */
export interface OracleIndexConfig extends IndexConfig {
  index_type?: OracleIndexTypeConfig;
  /** Vector index target accuracy percentage (1-100). */
  accuracy?: number;
  /**
   * Degree of parallelism for building the vector index.
   *
   * JavaScript-only build hint. It is not part of the table suffix and is not
   * registered in `STORE_CONFIGS`, so it never affects which tables a Python
   * store resolves to.
   */
  parallel?: number;
  /**
   * Name for the vector index, instead of the derived one.
   *
   * JavaScript-only, and excluded from the suffix and `STORE_CONFIGS` for the
   * same reason as {@link OracleIndexConfig.parallel}.
   */
  index_name?: string;
}

/** Shape of the persisted `STORE_CONFIGS` row used for validation. */
export interface StoredIndexConfigRow {
  detectedDims: number;
  distanceType: string;
  indexParams: unknown;
}

const HNSW_INDEX_TYPE_KEYS = new Set([
  "type",
  "distance_metric",
  "neighbors",
  "efconstruction",
]);

const IVF_INDEX_TYPE_KEYS = new Set([
  "type",
  "distance_metric",
  "neighbor_partitions",
  "samples_per_partition",
  "min_vectors_per_partition",
]);

/**
 * Distance metrics are never interpolated into DDL straight from user input.
 * The validated metric is used as a key into this table so that the text that
 * reaches Oracle is always one of our own literals.
 */
const DISTANCE_METRIC_SQL: Record<OracleVectorDistanceMetric, string> = {
  COSINE: "COSINE",
  EUCLIDEAN: "EUCLIDEAN",
  DOT: "DOT",
};

const HNSW_ORGANIZATION_SQL = "INMEMORY NEIGHBOR GRAPH";
const IVF_ORGANIZATION_SQL = "NEIGHBOR PARTITIONS";

/** Python hashes this shape when `index_type` is omitted; note it carries no metric. */
const SUFFIX_DEFAULT_INDEX_PARAMS = { type: "hnsw" };

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  return String(value);
}

/**
 * Integer bound check for every number interpolated into vector DDL.
 *
 * Only real, safe integers pass, so `String(value)` always renders as plain
 * digits and can never carry SQL text.
 */
export function validateIntegerOption(
  label: string,
  value: unknown,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(
      `OracleStore ${label} must be an integer. Received ${describeValue(value)}.`
    );
  }
  if (value < min || value > max) {
    throw new Error(
      `OracleStore ${label} must be between ${min} and ${max}. Received ${value}.`
    );
  }
  return value;
}

export function validateVectorDimensions(dims: unknown): number {
  if (
    typeof dims !== "number" ||
    !Number.isSafeInteger(dims) ||
    dims <= 0 ||
    dims > ORACLE_VECTOR_MAX_DIMENSIONS
  ) {
    throw new Error(
      `OracleStore index dims must be an integer between 1 and ${ORACLE_VECTOR_MAX_DIMENSIONS}. Received ${String(
        dims
      )}.`
    );
  }
  return dims;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Resolve and validate the distance metric.
 *
 * Python accepts any capitalization and upper-cases before comparing, so the
 * same is accepted here. The returned value is one of our own constants.
 */
export function resolveDistanceMetric(
  indexType: OracleIndexTypeConfig | undefined
): OracleVectorDistanceMetric {
  const raw = indexType?.distance_metric ?? "COSINE";
  if (typeof raw !== "string") {
    throw new Error("OracleStore index_type.distance_metric must be a string.");
  }
  const normalized = raw.toUpperCase();
  if (!Object.hasOwn(DISTANCE_METRIC_SQL, normalized)) {
    throw new Error(
      `OracleStore index_type.distance_metric must be one of ${ORACLE_VECTOR_DISTANCE_METRICS.join(
        ", "
      )}. Received ${describeValue(raw)}.`
    );
  }
  return normalized as OracleVectorDistanceMetric;
}

/**
 * Validate the whole index configuration before any DDL runs.
 *
 * Mirrors Python `_validate_index_config`, including its rejection of unknown
 * `index_type` keys, which is what keeps unexpected values out of the
 * generated `PARAMETERS` clause.
 */
export function validateOracleIndexConfig(config: OracleIndexConfig): void {
  validateVectorDimensions(config.dims);

  if (
    !config.embeddings ||
    typeof config.embeddings.embedDocuments !== "function" ||
    typeof config.embeddings.embedQuery !== "function"
  ) {
    throw new Error(
      "OracleStore index embeddings must provide embedDocuments and embedQuery methods."
    );
  }

  if (
    config.fields !== undefined &&
    (!Array.isArray(config.fields) ||
      !config.fields.every((field) => typeof field === "string"))
  ) {
    throw new Error("OracleStore index fields must be an array of strings.");
  }

  if (config.accuracy !== undefined && config.accuracy !== null) {
    validateIntegerOption("index accuracy", config.accuracy, 1, 100);
  }

  if (config.parallel !== undefined && config.parallel !== null) {
    validateIntegerOption("index parallel", config.parallel, 1);
  }

  if (config.index_name !== undefined) {
    validateIdentifier(config.index_name);
  }

  const indexType = config.index_type;
  if (indexType === undefined) return;

  if (!isPlainObject(indexType)) {
    throw new Error("OracleStore index_type must be a plain object.");
  }

  const kind = (indexType as OracleIndexTypeConfig).type ?? "hnsw";
  if (kind !== "hnsw" && kind !== "ivf") {
    throw new Error(
      `OracleStore index_type.type must be "hnsw" or "ivf". Received ${describeValue(
        kind
      )}.`
    );
  }

  const allowedKeys =
    kind === "hnsw" ? HNSW_INDEX_TYPE_KEYS : IVF_INDEX_TYPE_KEYS;
  const unknownKeys = Object.keys(indexType)
    .filter((key) => !allowedKeys.has(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw new Error(
      `OracleStore index_type contains unsupported keys: ${unknownKeys.join(", ")}.`
    );
  }

  resolveDistanceMetric(indexType);

  if (kind === "hnsw") {
    const hnsw = indexType as unknown as OracleHNSWIndexTypeConfig;
    if (hnsw.neighbors !== undefined) {
      validateIntegerOption("index_type.neighbors", hnsw.neighbors, 2, 2048);
    }
    if (hnsw.efconstruction !== undefined) {
      validateIntegerOption(
        "index_type.efconstruction",
        hnsw.efconstruction,
        1,
        65535
      );
    }
    return;
  }

  const ivf = indexType as unknown as OracleIVFIndexTypeConfig;
  if (ivf.neighbor_partitions !== undefined) {
    validateIntegerOption(
      "index_type.neighbor_partitions",
      ivf.neighbor_partitions,
      1,
      10000000
    );
  }
  if (ivf.samples_per_partition !== undefined) {
    validateIntegerOption(
      "index_type.samples_per_partition",
      ivf.samples_per_partition,
      1
    );
  }
  if (ivf.min_vectors_per_partition !== undefined) {
    validateIntegerOption(
      "index_type.min_vectors_per_partition",
      ivf.min_vectors_per_partition,
      0
    );
  }
}

/**
 * `json.dumps(value, sort_keys=True)` as Python writes it.
 *
 * Keys sort by code point (not locale), separators keep Python's spaces, and
 * non-ASCII is escaped the way `ensure_ascii=True` does. The store suffix is a
 * hash of this text, so any deviation silently points at different tables.
 */
export function pythonJsonDumps(
  value: unknown,
  options: { ensureAscii?: boolean } = {}
): string {
  const { ensureAscii = true } = options;
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `OracleStore cannot serialize the non-finite number ${String(value)}.`
      );
    }
    return String(value);
  }
  if (typeof value === "string") return pythonJsonString(value, ensureAscii);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJsonDumps(item, options)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(
        ([key, nested]) =>
          `${pythonJsonString(key, ensureAscii)}: ${pythonJsonDumps(
            nested,
            options
          )}`
      )
      .join(", ")}}`;
  }
  throw new Error(
    `OracleStore cannot serialize a ${typeof value} value into an index configuration.`
  );
}

function pythonJsonString(value: string, ensureAscii = true): string {
  if (!ensureAscii) return JSON.stringify(value);
  // `ensure_ascii=True` escapes everything outside the printable ASCII range,
  // including DEL, which JSON.stringify leaves as a literal character.
  return JSON.stringify(value).replace(
    /[\u{7f}-\u{ffff}]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** Index parameters as Python hashes them into the table suffix. */
export function suffixIndexParams(
  config: OracleIndexConfig | undefined
): Record<string, unknown> {
  return (
    (config?.index_type as Record<string, unknown> | undefined) ??
    SUFFIX_DEFAULT_INDEX_PARAMS
  );
}

/**
 * Deterministic table suffix, byte-for-byte compatible with Python
 * `_generate_suffix`.
 */
export function defaultTableSuffix(
  config: OracleIndexConfig | undefined
): string {
  if (!config) return "novec";
  const serialized = pythonJsonDumps({
    dims: config.dims,
    fields: config.fields ?? ["$"],
    index_params: suffixIndexParams(config),
  });
  return createHash("sha256").update(serialized).digest("hex").slice(0, 6);
}

/** `STORE_CONFIGS.distance_type` as Python registers it. */
export function storeConfigDistanceType(config: OracleIndexConfig): string {
  return resolveDistanceMetric(config.index_type);
}

/** `STORE_CONFIGS.index_params` as Python registers it, accuracy included. */
export function storeConfigIndexParams(
  config: OracleIndexConfig
): Record<string, unknown> {
  return {
    ...suffixIndexParams(config),
    accuracy: config.accuracy ?? null,
  };
}

/** `STORE_CONFIGS.embed_fields` as Python registers it. */
export function storeConfigEmbedFields(config: OracleIndexConfig): string {
  const fields = config.fields ?? ["$"];
  return fields.length > 0 ? fields.join(",") : "$";
}

function normalizeStoredIndexParams(
  storedParams: unknown
): Record<string, unknown> {
  let parsed = storedParams;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(
        "Stored index configuration is not valid JSON. Use a different tableSuffix or drop existing tables."
      );
    }
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new Error(
      "Stored index configuration must decode to a JSON object. Use a different tableSuffix or drop existing tables."
    );
  }
  return { ...parsed };
}

/**
 * Compare a configuration against the row Python (or a previous run) wrote to
 * `STORE_CONFIGS`. Mirrors Python `_validate_configuration`.
 */
export function assertStoredIndexConfigMatches(
  tableSuffix: string,
  config: OracleIndexConfig,
  stored: StoredIndexConfigRow
): void {
  if (Number(stored.detectedDims) !== config.dims) {
    throw new Error(
      `Dimension mismatch for tableSuffix "${tableSuffix}": existing ${String(
        stored.detectedDims
      )} dimensions, provided ${config.dims}. Different embedding dimensions require different table sets. Use a different tableSuffix or drop existing tables.`
    );
  }

  const distanceType = storeConfigDistanceType(config);
  const storedDistance = String(stored.distanceType ?? "").toUpperCase();
  if (storedDistance && storedDistance !== distanceType) {
    throw new Error(
      `Distance type mismatch for tableSuffix "${tableSuffix}": existing ${storedDistance}, provided ${distanceType}. Changing distance metrics requires new tables.`
    );
  }

  const storedParams = normalizeStoredIndexParams(stored.indexParams);
  const storedAccuracy = storedParams.accuracy ?? null;
  delete storedParams.accuracy;
  const accuracy = config.accuracy ?? null;
  if (storedAccuracy !== accuracy) {
    throw new Error(
      `Index accuracy mismatch for tableSuffix "${tableSuffix}": existing ${String(
        storedAccuracy
      )}, provided ${String(accuracy)}. Changing accuracy requires new tables.`
    );
  }

  const provided = pythonJsonDumps(suffixIndexParams(config));
  const existing = pythonJsonDumps(storedParams);
  if (provided !== existing) {
    throw new Error(
      `Index parameter mismatch for tableSuffix "${tableSuffix}": existing ${existing}, provided ${provided}. Changing index parameters requires new tables.`
    );
  }
}

/** Oracle `ORGANIZATION` clause. Mirrors Python `_get_organization_clause`. */
export function organizationClause(config: OracleIndexConfig): string {
  const indexType = config.index_type;
  if (!indexType) return HNSW_ORGANIZATION_SQL;
  return indexType.type === "ivf"
    ? IVF_ORGANIZATION_SQL
    : HNSW_ORGANIZATION_SQL;
}

/** Oracle `WITH TARGET ACCURACY` clause. Mirrors Python `_get_target_accuracy_clause`. */
export function targetAccuracyClause(config: OracleIndexConfig): string {
  if (config.accuracy === undefined || config.accuracy === null) return "";
  const accuracy = validateIntegerOption(
    "index accuracy",
    config.accuracy,
    1,
    100
  );
  return `WITH TARGET ACCURACY ${accuracy}`;
}

/**
 * Oracle `PARAMETERS` clause. Mirrors Python `_get_parameters_clause`,
 * including its omission of the clause entirely when `index_type` is absent.
 */
export function parametersClause(config: OracleIndexConfig): string {
  const indexType = config.index_type;
  if (!indexType) return "";

  if ((indexType.type ?? "hnsw") === "hnsw") {
    const hnsw = indexType as OracleHNSWIndexTypeConfig;
    let parameters = "PARAMETERS (type HNSW";
    if (hnsw.neighbors !== undefined) {
      parameters += `, neighbors ${validateIntegerOption(
        "index_type.neighbors",
        hnsw.neighbors,
        2,
        2048
      )}`;
    }
    if (hnsw.efconstruction !== undefined) {
      parameters += `, efconstruction ${validateIntegerOption(
        "index_type.efconstruction",
        hnsw.efconstruction,
        1,
        65535
      )}`;
    }
    return `${parameters})`;
  }

  const ivf = indexType as OracleIVFIndexTypeConfig;
  let parameters = "PARAMETERS (type IVF";
  if (ivf.neighbor_partitions !== undefined) {
    parameters += `, neighbor partitions ${validateIntegerOption(
      "index_type.neighbor_partitions",
      ivf.neighbor_partitions,
      1,
      10000000
    )}`;
  }
  if (ivf.samples_per_partition !== undefined) {
    parameters += `, samples_per_partition ${validateIntegerOption(
      "index_type.samples_per_partition",
      ivf.samples_per_partition,
      1
    )}`;
  }
  if (ivf.min_vectors_per_partition !== undefined) {
    parameters += `, min_vectors_per_partition ${validateIntegerOption(
      "index_type.min_vectors_per_partition",
      ivf.min_vectors_per_partition,
      0
    )}`;
  }
  return `${parameters})`;
}

/**
 * Deterministic name for the index created during setup.
 *
 * Python derives this from `hash(str(index_config))`, which is salted per
 * process and therefore not reproducible. A content hash is used instead so
 * repeated setups converge on one index.
 */
export function configuredVectorIndexName(
  vectorTableName: string,
  config: OracleIndexConfig
): string {
  if (config.index_name !== undefined) {
    return validateIdentifier(config.index_name);
  }
  const digest = createHash("sha256")
    .update(pythonJsonDumps(storeConfigIndexParams(config)))
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  return generatedIdentifier(`${vectorTableName}_IDX_${digest}`);
}

/**
 * `CREATE VECTOR INDEX` for a store index configuration.
 *
 * Every interpolated fragment is either a validated identifier, a bounded
 * integer, or one of our own literals.
 */
export function createConfiguredVectorIndexSQL(
  vectorTableName: string,
  config: OracleIndexConfig
): string {
  validateOracleIndexConfig(config);
  const indexName = configuredVectorIndexName(vectorTableName, config);
  const metric = DISTANCE_METRIC_SQL[resolveDistanceMetric(config.index_type)];
  const clauses = [
    `CREATE VECTOR INDEX ${indexName}`,
    `ON ${vectorTableName} (embedding)`,
    `ORGANIZATION ${organizationClause(config)}`,
    `DISTANCE ${metric}`,
  ];
  const accuracy = targetAccuracyClause(config);
  if (accuracy) clauses.push(accuracy);
  const parameters = parametersClause(config);
  if (parameters) clauses.push(parameters);
  if (config.parallel !== undefined && config.parallel !== null) {
    clauses.push(
      `PARALLEL ${validateIntegerOption("index parallel", config.parallel, 1)}`
    );
  }
  return clauses.join("\n");
}

/** Distance metric literal for use inside `VECTOR_DISTANCE(...)`. */
export function distanceMetricSQL(config: OracleIndexConfig): string {
  return DISTANCE_METRIC_SQL[resolveDistanceMetric(config.index_type)];
}

/**
 * Convert a `VECTOR_DISTANCE` result into a similarity score.
 *
 * Mirrors Python `get_distance_operator`: cosine distance becomes
 * `1 - distance`, every other metric is negated so that larger is closer.
 */
export function scoreFromDistanceSQL(
  config: OracleIndexConfig,
  distanceExpression: string
): string {
  return resolveDistanceMetric(config.index_type) === "COSINE"
    ? `1 - ${distanceExpression}`
    : `-${distanceExpression}`;
}

/* eslint-disable no-instanceof/no-instanceof */

import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";
import { copyCheckpoint } from "@langchain/langgraph-checkpoint";

/** A graph deployment version stored alongside persisted checkpoints. */
export type GraphVersion = string | number;

/**
 * The persisted state a migration is allowed to transform.
 *
 * Pending writes are included because interrupted runs can carry old-shaped
 * resume values or task payloads that will be consumed after migration.
 */
export type StateMigrationState = {
  checkpoint: Checkpoint;
  pendingWrites: CheckpointPendingWrite[];
};

/**
 * Transforms persisted state while moving it between graph versions.
 *
 * The checkpoint id must remain unchanged because it is part of the
 * checkpointer's address.
 */
export type StateMigration = {
  from: GraphVersion;
  to: GraphVersion;
  migrate: (
    state: StateMigrationState
  ) => StateMigrationState | Promise<StateMigrationState>;
};

export function validateStateMigrations(
  graphVersion: GraphVersion | undefined,
  legacyGraphVersion: GraphVersion | undefined,
  migrations: readonly StateMigration[] | undefined
): void {
  if (graphVersion !== undefined) {
    validateGraphVersion(graphVersion, "graphVersion");
  }
  if (legacyGraphVersion !== undefined) {
    validateGraphVersion(legacyGraphVersion, "legacyGraphVersion");
  }
  if (legacyGraphVersion !== undefined && graphVersion === undefined) {
    throw new Error(
      "legacyGraphVersion requires graphVersion to be configured."
    );
  }
  if (migrations === undefined) return;
  if (!Array.isArray(migrations)) {
    throw new Error("stateMigrations must be an array.");
  }
  if (migrations.length === 0) return;
  if (graphVersion === undefined) {
    throw new Error("stateMigrations requires graphVersion to be configured.");
  }

  const fromVersions = new Set<GraphVersion>();
  for (const migration of migrations) {
    if (migration === null || typeof migration !== "object") {
      throw new Error("stateMigrations entries must be objects.");
    }
    validateGraphVersion(migration.from, "stateMigrations.from");
    validateGraphVersion(migration.to, "stateMigrations.to");
    if (typeof migration.migrate !== "function") {
      throw new Error(
        "stateMigrations entries must define a migrate function."
      );
    }
    if (migration.from === migration.to) {
      throw new Error(
        `stateMigrations cannot migrate from ${String(migration.from)} to the same version.`
      );
    }
    if (fromVersions.has(migration.from)) {
      throw new Error(
        `stateMigrations contains multiple migrations from version ${String(migration.from)}.`
      );
    }
    fromVersions.add(migration.from);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isVersion(value: unknown): value is GraphVersion {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  );
}

function validateGraphVersion(value: unknown, name: string): void {
  if (!isVersion(value)) {
    throw new Error(`${name} must be a finite number or string.`);
  }
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!isRecord(value)) return false;
  const checkpoint = value as Partial<Checkpoint>;
  if (
    typeof checkpoint.id !== "string" ||
    typeof checkpoint.v !== "number" ||
    !Number.isInteger(checkpoint.v) ||
    checkpoint.v < 0 ||
    typeof checkpoint.ts !== "string" ||
    !isRecord(checkpoint.channel_values) ||
    !isRecord(checkpoint.channel_versions) ||
    !isRecord(checkpoint.versions_seen)
  ) {
    return false;
  }

  if (!Object.values(checkpoint.channel_versions).every(isVersion)) {
    return false;
  }
  return Object.values(checkpoint.versions_seen).every(
    (versions) => isRecord(versions) && Object.values(versions).every(isVersion)
  );
}

function isPendingWrites(value: unknown): value is CheckpointPendingWrite[] {
  return (
    Array.isArray(value) &&
    value.every(
      (write) =>
        Array.isArray(write) &&
        write.length === 3 &&
        typeof write[0] === "string" &&
        typeof write[1] === "string"
    )
  );
}

function isMigrationState(value: unknown): value is StateMigrationState {
  if (!isRecord(value)) return false;
  return isCheckpoint(value.checkpoint) && isPendingWrites(value.pendingWrites);
}

/**
 * Clone persisted values without dropping custom prototypes such as message
 * values. Migration callbacks can therefore mutate nested data without
 * changing the checkpointer's returned tuple.
 */
function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  const existing = seen.get(object);
  if (existing !== undefined) return existing as T;

  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp)
    return new RegExp(value.source, value.flags) as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(object, clone);
    for (const [key, entry] of value) {
      clone.set(cloneValue(key, seen), cloneValue(entry, seen));
    }
    return clone as T;
  }
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(object, clone);
    for (const entry of value) clone.add(cloneValue(entry, seen));
    return clone as T;
  }

  const clone = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  seen.set(object, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ("value" in descriptor)
      descriptor.value = cloneValue(descriptor.value, seen);
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

function cloneMigrationState(
  checkpoint: Checkpoint,
  pendingWrites: CheckpointPendingWrite[]
): StateMigrationState {
  return cloneValue({
    checkpoint: {
      v: checkpoint.v,
      id: checkpoint.id,
      ts: checkpoint.ts,
      channel_values: checkpoint.channel_values,
      channel_versions: checkpoint.channel_versions,
      versions_seen: checkpoint.versions_seen,
    },
    pendingWrites,
  });
}

/**
 * Migrate persisted state to the compiled graph's version.
 *
 * Checkpoints without metadata require `legacyGraphVersion`. New, empty
 * checkpoints are treated as current by passing `isNewCheckpoint`.
 */
export async function migrateCheckpoint({
  checkpoint,
  pendingWrites = [],
  metadata,
  graphVersion,
  legacyGraphVersion,
  migrations,
  isNewCheckpoint = false,
  hasDeltaChannels = false,
}: {
  checkpoint: Checkpoint;
  pendingWrites?: CheckpointPendingWrite[];
  metadata?: CheckpointMetadata;
  graphVersion?: GraphVersion;
  legacyGraphVersion?: GraphVersion;
  migrations?: readonly StateMigration[];
  isNewCheckpoint?: boolean;
  hasDeltaChannels?: boolean;
}): Promise<{
  checkpoint: Checkpoint;
  pendingWrites: CheckpointPendingWrite[];
  metadata?: CheckpointMetadata;
}> {
  validateStateMigrations(graphVersion, legacyGraphVersion, migrations);
  if (!isCheckpoint(checkpoint)) {
    throw new Error("Checkpoint is not valid persisted state.");
  }
  if (!isPendingWrites(pendingWrites)) {
    throw new Error(`Checkpoint ${checkpoint.id} has invalid pending writes.`);
  }
  if (metadata?.graph_version !== undefined) {
    validateGraphVersion(metadata.graph_version, "Checkpoint graph_version");
  }

  if (graphVersion === undefined) {
    if (metadata?.graph_version !== undefined) {
      throw new Error(
        `Checkpoint ${checkpoint.id} belongs to graph version ${String(metadata.graph_version)}, but this graph has no graphVersion configured.`
      );
    }
    return {
      checkpoint: copyCheckpoint(checkpoint),
      pendingWrites: cloneValue(pendingWrites),
      metadata,
    };
  }

  if (
    metadata?.graph_version === undefined &&
    !isNewCheckpoint &&
    legacyGraphVersion === undefined
  ) {
    throw new Error(
      `Checkpoint ${checkpoint.id} has no graph_version. Configure legacyGraphVersion before reading checkpoints created before graph versioning.`
    );
  }

  const fromVersion =
    metadata?.graph_version ??
    legacyGraphVersion ??
    // A new checkpoint has no persisted state to migrate.
    graphVersion;
  if (fromVersion === graphVersion) {
    return {
      checkpoint: copyCheckpoint(checkpoint),
      pendingWrites: cloneValue(pendingWrites),
      metadata: {
        ...metadata,
        graph_version: graphVersion,
      } as CheckpointMetadata,
    };
  }

  // ponytail: fail closed until the saver can rewrite DeltaChannel ancestor
  // history; replaying old writes under a new schema would corrupt state.
  if (hasDeltaChannels) {
    throw new Error(
      "State migrations are not supported for graphs with DeltaChannel. Migrate the DeltaChannel history and create a new snapshot before changing graphVersion."
    );
  }

  const byFrom = new Map<GraphVersion, StateMigration>();
  for (const migration of migrations ?? []) {
    byFrom.set(migration.from, migration);
  }

  const originalCheckpointId = checkpoint.id;
  let migratedState = cloneMigrationState(checkpoint, pendingWrites);
  const visited = new Set<GraphVersion>();
  let currentVersion = fromVersion;
  while (currentVersion !== graphVersion) {
    if (visited.has(currentVersion)) {
      throw new Error(
        `stateMigrations contains a cycle while migrating from version ${String(fromVersion)} to ${String(graphVersion)}.`
      );
    }
    visited.add(currentVersion);

    const migration = byFrom.get(currentVersion);
    if (migration === undefined) {
      throw new Error(
        `No state migration is registered from graph version ${String(currentVersion)} to ${String(graphVersion)}.`
      );
    }

    const nextState = await migration.migrate(migratedState);
    if (!isMigrationState(nextState)) {
      throw new Error(
        `State migration from ${String(migration.from)} to ${String(migration.to)} must return a valid checkpoint and pendingWrites array.`
      );
    }
    if (nextState.checkpoint.id !== originalCheckpointId) {
      throw new Error(
        `State migration from ${String(migration.from)} to ${String(migration.to)} cannot change checkpoint id.`
      );
    }
    migratedState = cloneMigrationState(
      nextState.checkpoint,
      nextState.pendingWrites
    );
    currentVersion = migration.to;
  }

  return {
    ...migratedState,
    metadata: {
      ...metadata,
      graph_version: graphVersion,
    } as CheckpointMetadata,
  };
}

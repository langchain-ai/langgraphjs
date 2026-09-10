/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-instanceof/no-instanceof */
import { load } from "@langchain/core/load";
import { SerializerProtocol } from "./base.js";
import { stringify } from "./utils/fast-safe-stringify/index.js";
import { type ConstructorRecord, DeltaSnapshot } from "./types.js";

function isLangChainSerializedObject(value: Record<string, unknown>) {
  return (
    value !== null &&
    value.lc === 1 &&
    value.type === "constructor" &&
    Array.isArray(value.id)
  );
}

function isUndefinedRecord(value: Record<string, unknown>): boolean {
  return value.lc === 2 && value.type === "undefined";
}

function isDeltaSnapshotRecord(value: Record<string, unknown>): boolean {
  return (
    value.lc === 2 &&
    value.type === "delta_snapshot" &&
    Object.prototype.hasOwnProperty.call(value, "value")
  );
}

function isConstructorRecord(
  value: Record<string, unknown>
): value is ConstructorRecord {
  return value.lc === 2 && value.type === "constructor";
}

function hasConstructorId(record: ConstructorRecord, name: string): boolean {
  return (
    Array.isArray(record.id) && record.id.length === 1 && record.id[0] === name
  );
}

function hasNoMethod(record: ConstructorRecord): boolean {
  return record.method === undefined || record.method === null;
}

function hasSingleArrayArg(
  record: ConstructorRecord
): record is ConstructorRecord & { args: unknown[][] } {
  return (
    Array.isArray(record.args) &&
    record.args.length === 1 &&
    Array.isArray(record.args[0])
  );
}

function isByteArray(value: unknown[]): value is number[] {
  return value.every(
    (item) =>
      typeof item === "number" &&
      Number.isInteger(item) &&
      item >= 0 &&
      item <= 255
  );
}

/**
 * Reconstruct only the closed set of lc:2 values written by `_default`.
 *
 * A constructor record is serialized data, not an instruction to resolve a
 * property or invoke a method. Invalid and unsupported records are kept inert
 * by the caller so old or attacker-controlled checkpoint data cannot execute.
 */
function reviveConstructorRecord(
  record: ConstructorRecord
): unknown | undefined {
  if (hasConstructorId(record, "Set") && hasNoMethod(record)) {
    if (!hasSingleArrayArg(record)) return undefined;
    return new Set(record.args[0]);
  }

  if (hasConstructorId(record, "Map") && hasNoMethod(record)) {
    if (
      !hasSingleArrayArg(record) ||
      !record.args[0].every(
        (entry) => Array.isArray(entry) && entry.length === 2
      )
    ) {
      return undefined;
    }
    return new Map(record.args[0] as [unknown, unknown][]);
  }

  if (hasConstructorId(record, "RegExp") && hasNoMethod(record)) {
    if (
      !Array.isArray(record.args) ||
      record.args.length !== 2 ||
      typeof record.args[0] !== "string" ||
      typeof record.args[1] !== "string"
    ) {
      return undefined;
    }
    try {
      return new RegExp(record.args[0], record.args[1]);
    } catch {
      // Invalid patterns are malformed persisted data and stay inert.
      return undefined;
    }
  }

  if (hasConstructorId(record, "Error") && hasNoMethod(record)) {
    if (
      !Array.isArray(record.args) ||
      record.args.length !== 1 ||
      typeof record.args[0] !== "string"
    ) {
      return undefined;
    }
    return new Error(record.args[0]);
  }

  if (
    hasConstructorId(record, "Uint8Array") &&
    (hasNoMethod(record) || record.method === "from")
  ) {
    if (!hasSingleArrayArg(record) || !isByteArray(record.args[0])) {
      return undefined;
    }
    // `from` is a legacy format tag. Do not forward its serialized method or
    // any extra arguments: the validated bytes are the entire persisted form.
    return new Uint8Array(record.args[0]);
  }

  return undefined;
}

/**
 * The replacer in stringify does not allow delegation to built-in LangChain
 * serialization methods, and instead immediately calls `.toJSON()` and
 * continues to stringify subfields.
 *
 * We therefore must start from the most nested elements in the input and
 * deserialize upwards rather than top-down.
 */
async function _reviver(value: any): Promise<any> {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      const revivedArray = await Promise.all(
        value.map((item) => _reviver(item))
      );
      return revivedArray;
    } else {
      const revivedObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        revivedObj[k] = await _reviver(v);
      }

      if (isUndefinedRecord(revivedObj)) {
        return undefined;
      } else if (isDeltaSnapshotRecord(revivedObj)) {
        // Wrapped value is already revived (bottom-up traversal).
        return new DeltaSnapshot(revivedObj.value);
      } else if (isConstructorRecord(revivedObj)) {
        return reviveConstructorRecord(revivedObj) ?? revivedObj;
      } else if (isLangChainSerializedObject(revivedObj)) {
        return load(JSON.stringify(revivedObj));
      }

      return revivedObj;
    }
  }
  return value;
}

function _encodeConstructorArgs(
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-function-type
  constructor: Function,
  method?: string,
  args?: any[],
  kwargs?: Record<string, any>
): object {
  return {
    lc: 2,
    type: "constructor",
    id: [constructor.name],
    method: method ?? null,
    args: args ?? [],
    kwargs: kwargs ?? {},
  };
}

function _default(obj: any): any {
  if (obj === undefined) {
    return {
      lc: 2,
      type: "undefined",
    };
  } else if (obj instanceof DeltaSnapshot) {
    return {
      lc: 2,
      type: "delta_snapshot",
      // `value` continues to be walked by `stringify`, so nested
      // serializable types (messages, Maps, etc.) are encoded normally.
      value: obj.value,
    };
  } else if (obj instanceof Set || obj instanceof Map) {
    return _encodeConstructorArgs(obj.constructor, undefined, [
      Array.from(obj),
    ]);
  } else if (obj instanceof RegExp) {
    return _encodeConstructorArgs(RegExp, undefined, [obj.source, obj.flags]);
  } else if (obj instanceof Error) {
    return _encodeConstructorArgs(Error, undefined, [obj.message]);
    // TODO: Remove special case
  } else if (obj?.lg_name === "Send") {
    return {
      node: obj.node,
      args: obj.args,
      // preserve an optional per-task timeout policy across (de)serialization
      ...(obj.timeout !== undefined ? { timeout: obj.timeout } : {}),
    };
  } else if (obj instanceof Uint8Array) {
    return _encodeConstructorArgs(Uint8Array, "from", [Array.from(obj)]);
  } else {
    return obj;
  }
}

export class JsonPlusSerializer implements SerializerProtocol {
  protected _dumps(obj: any): Uint8Array {
    const encoder = new TextEncoder();
    return encoder.encode(
      stringify(obj, (_: string, value: any) => {
        return _default(value);
      })
    );
  }

  async dumpsTyped(obj: any): Promise<[string, Uint8Array]> {
    if (obj instanceof Uint8Array) {
      return ["bytes", obj];
    } else {
      return ["json", this._dumps(obj)];
    }
  }

  protected async _loads(data: string): Promise<any> {
    const parsed = JSON.parse(data);
    return _reviver(parsed);
  }

  async loadsTyped(type: string, data: Uint8Array | string): Promise<any> {
    if (type === "bytes") {
      return typeof data === "string" ? new TextEncoder().encode(data) : data;
    } else if (type === "json") {
      return this._loads(
        typeof data === "string" ? data : new TextDecoder().decode(data)
      );
    } else {
      throw new Error(`Unknown serialization type: ${type}`);
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-instanceof/no-instanceof */
import { load } from "@langchain/core/load";
import { SerializerProtocol } from "./base.js";

function isLangChainSerializable(value: Record<string, unknown>) {
  return (
    typeof value.lc_serializable === "boolean" && Array.isArray(value.lc_id)
  );
}

function isLangChainSerializedObject(value: Record<string, unknown>) {
  return (
    value !== null &&
    value.lc === 1 &&
    value.type === "constructor" &&
    Array.isArray(value.id)
  );
}

const _serialize = (value: any, seen = new WeakSet()): string => {
  const defaultValue = _default("", value);

  if (defaultValue === null) {
    return "null";
  } else if (typeof defaultValue === "string") {
    return JSON.stringify(defaultValue);
  } else if (
    typeof defaultValue === "number" ||
    typeof defaultValue === "boolean"
  ) {
    return defaultValue.toString();
  } else if (typeof defaultValue === "object") {
    if (seen.has(defaultValue)) {
      throw new TypeError("Circular reference detected");
    }
    seen.add(defaultValue);

    if (Array.isArray(defaultValue)) {
      const result = `[${defaultValue
        .map((item) => _serialize(item, seen))
        .join(",")}]`;
      seen.delete(defaultValue);
      return result;
    } else if (isLangChainSerializable(defaultValue)) {
      return JSON.stringify(defaultValue);
    } else {
      const entries = Object.entries(defaultValue).map(
        ([k, v]) => `${JSON.stringify(k)}:${_serialize(v, seen)}`
      );
      const result = `{${entries.join(",")}}`;
      seen.delete(defaultValue);
      return result;
    }
  }
  // Only be reached for functions or symbols
  return JSON.stringify(defaultValue);
};

async function _reviver(value: any): Promise<any> {
  if (value && typeof value === "object") {
    if (value.lc === 2 && value.type === "undefined") {
      return undefined;
    } else if (
      value.lc === 2 &&
      value.type === "constructor" &&
      Array.isArray(value.id)
    ) {
      try {
        const constructorName = value.id[value.id.length - 1];
        let constructor: any;

        switch (constructorName) {
          case "Set":
            constructor = Set;
            break;
          case "Map":
            constructor = Map;
            break;
          case "RegExp":
            constructor = RegExp;
            break;
          case "Error":
            constructor = Error;
            break;
          default:
            return value;
        }
        if (value.method) {
          return (constructor as any)[value.method](...(value.args || []));
        } else {
          return new (constructor as any)(...(value.args || []));
        }
      } catch (error) {
        return value;
      }
    } else if (isLangChainSerializedObject(value)) {
      return load(JSON.stringify(value));
    } else if (Array.isArray(value)) {
      return Promise.all(value.map((item) => _reviver(item)));
    } else {
      const revivedObj: any = {};
      for (const [k, v] of Object.entries(value)) {
        revivedObj[k] = await _reviver(v);
      }
      return revivedObj;
    }
  }
  return value;
}

function _encodeConstructorArgs(
  // eslint-disable-next-line @typescript-eslint/ban-types
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

function _default(_key: string, obj: any): any {
  if (obj === undefined) {
    return {
      lc: 2,
      type: "undefined",
    };
  } else if (obj instanceof Set || obj instanceof Map) {
    return _encodeConstructorArgs(obj.constructor, undefined, [
      Array.from(obj),
    ]);
  } else if (obj instanceof RegExp) {
    return _encodeConstructorArgs(RegExp, undefined, [obj.source, obj.flags]);
  } else if (obj instanceof Error) {
    return _encodeConstructorArgs(obj.constructor, undefined, [obj.message]);
  } else {
    return obj;
  }
}

export class JsonPlusSerializer implements SerializerProtocol {
  protected _dumps(obj: any): Uint8Array {
    const encoder = new TextEncoder();
    return encoder.encode(_serialize(obj));
  }

  dumpsTyped(obj: any): [string, Uint8Array] {
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

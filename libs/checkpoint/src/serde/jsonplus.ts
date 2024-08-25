/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-instanceof/no-instanceof */
import { load } from "@langchain/core/load";
import { SerializerProtocol } from "./base.js";

async function _reviver(value: any): Promise<any> {
  if (value && typeof value === "object") {
    if (
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
    } else if (value.lc === 1) {
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
    console.warn(`Serializer received an explicit "undefined" value. Converting to "null".`);
    return null;
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
    const jsonString = JSON.stringify(obj, (key, value) => {
      if (value && typeof value === "object") {
        if (Array.isArray(value)) {
          // Handle arrays
          return value.map((item) => _default(key, item));
        } else {
          // Handle objects
          const serialized: any = {};
          for (const [k, v] of Object.entries(value)) {
            serialized[k] = _default(k, v);
          }
          return serialized;
        }
      }
      return _default(key, value);
    });
    return new TextEncoder().encode(jsonString);
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

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-instanceof/no-instanceof */
import { load } from "@langchain/core/load";
import { SerializerProtocol } from "./base.js";
import { stringify } from "./utils/fast-safe-stringify/index.js";

function isLangChainSerializedObject(value: Record<string, unknown>) {
  return (
    value !== null &&
    value.lc === 1 &&
    value.type === "constructor" &&
    Array.isArray(value.id)
  );
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
      const revivedObj: any = {};
      for (const [k, v] of Object.entries(value)) {
        revivedObj[k] = await _reviver(v);
      }

      if (revivedObj.lc === 2 && revivedObj.type === "undefined") {
        return undefined;
      } else if (
        revivedObj.lc === 2 &&
        revivedObj.type === "constructor" &&
        Array.isArray(revivedObj.id)
      ) {
        try {
          const constructorName = revivedObj.id[revivedObj.id.length - 1];
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
              return revivedObj;
          }
          if (revivedObj.method) {
            return (constructor as any)[revivedObj.method](
              ...(revivedObj.args || [])
            );
          } else {
            return new (constructor as any)(...(revivedObj.args || []));
          }
        } catch (error) {
          return revivedObj;
        }
      } else if (isLangChainSerializedObject(revivedObj)) {
        return load(JSON.stringify(revivedObj));
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

function _default(obj: any): any {
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
    // TODO: Remove special case
  } else if (obj?.lg_name === "Send") {
    return {
      node: obj.node,
      args: obj.args,
    };
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

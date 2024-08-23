/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-instanceof/no-instanceof */
import { load } from "@langchain/core/load";
import { SerializerProtocol } from "./base.js";

export class JsonPlusSerializer implements SerializerProtocol {
  private _encodeConstructorArgs(
    // eslint-disable-next-line @typescript-eslint/ban-types
    constructor: Function,
    method?: string,
    args?: any[],
    kwargs?: Record<string, any>
  ): object {
    return {
      lc: 2,
      type: "constructor",
      id: [...constructor.name.split("."), constructor.name],
      method,
      args: args ?? [],
      kwargs: kwargs ?? {},
    };
  }

  private _default(_key: string, obj: any): any {
    if (obj instanceof Set || obj instanceof Map) {
      return this._encodeConstructorArgs(obj.constructor, undefined, [
        Array.from(obj),
      ]);
    } else if (obj instanceof RegExp) {
      return this._encodeConstructorArgs(RegExp, undefined, [
        obj.source,
        obj.flags,
      ]);
    } else if (obj instanceof Error) {
      return this._encodeConstructorArgs(obj.constructor, undefined, [
        obj.message,
      ]);
    } else {
      return JSON.stringify(obj);
    }
  }

  private _reviver(_key: string, value: any): any {
    if (
      value &&
      typeof value === "object" &&
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
    }
    return load(value);
  }

  _dumps(obj: any): Uint8Array {
    const jsonString = JSON.stringify(obj, this._default.bind(this));
    return new TextEncoder().encode(jsonString);
  }

  dumpsTyped(obj: any): [string, Uint8Array] {
    // eslint-disable-next-line no-instanceof/no-instanceof
    if (obj instanceof Uint8Array) {
      return ["bytes", obj];
    } else {
      return ["json", this._dumps(obj)];
    }
  }

  _loads(data: string): any {
    return JSON.parse(data, this._reviver);
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

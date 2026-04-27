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
 * Default LangChain `id` namespace prefixes whose classes are pure data
 * containers (no I/O, no network, no env access in their constructors) and
 * are therefore safe to instantiate when reviving a checkpoint.
 *
 * Other LangChain namespaces (tools, retrievers, vectorstores, language
 * models, document loaders, agents, callbacks, etc.) can have construction
 * side effects — instantiating them from a checkpoint payload that an
 * attacker can influence is an insecure-deserialization sink. Those classes
 * are intentionally not loaded; their envelopes pass through as plain
 * objects unless the embedding application opts in via
 * `JsonPlusSerializerOptions.loadableLangChainPrefixes`.
 */
const DEFAULT_LOADABLE_LC_PREFIXES: readonly (readonly string[])[] = [
  ["langchain_core", "messages"],
  ["langchain_core", "documents"],
  ["langchain_core", "prompt_values"],
  ["langchain_core", "outputs"],
];

function idMatchesPrefix(
  id: readonly unknown[],
  prefix: readonly string[]
): boolean {
  if (id.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (id[i] !== prefix[i]) return false;
  }
  return true;
}

function isLoadableLangChainId(
  id: readonly unknown[],
  allowedPrefixes: readonly (readonly string[])[]
): boolean {
  return allowedPrefixes.some((prefix) => idMatchesPrefix(id, prefix));
}

/**
 * The replacer in stringify does not allow delegation to built-in LangChain
 * serialization methods, and instead immediately calls `.toJSON()` and
 * continues to stringify subfields.
 *
 * We therefore must start from the most nested elements in the input and
 * deserialize upwards rather than top-down.
 */
async function _reviver(
  value: any,
  loadableLangChainPrefixes: readonly (readonly string[])[]
): Promise<any> {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      const revivedArray = await Promise.all(
        value.map((item) => _reviver(item, loadableLangChainPrefixes))
      );
      return revivedArray;
    } else {
      const revivedObj: any = {};
      for (const [k, v] of Object.entries(value)) {
        revivedObj[k] = await _reviver(v, loadableLangChainPrefixes);
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
            case "Uint8Array":
              constructor = Uint8Array;
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
        } catch {
          return revivedObj;
        }
      } else if (isLangChainSerializedObject(revivedObj)) {
        if (
          !isLoadableLangChainId(
            revivedObj.id as unknown[],
            loadableLangChainPrefixes
          )
        ) {
          return revivedObj;
        }
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
  } else if (obj instanceof Uint8Array) {
    return _encodeConstructorArgs(Uint8Array, "from", [Array.from(obj)]);
  } else {
    return obj;
  }
}

export interface JsonPlusSerializerOptions {
  /**
   * Additional LangChain `id` namespace prefixes that may be passed to
   * `@langchain/core/load` during deserialization, on top of the built-in
   * defaults (messages, documents, prompt_values, outputs).
   *
   * Each prefix is an array of namespace path segments; an envelope is
   * considered loadable if its `id` starts with any allowed prefix.
   *
   * **Security:** only add namespaces whose classes have side-effect-free
   * constructors. Adding tool, retriever, loader, vector store, or language
   * model namespaces widens the deserialization attack surface — never
   * derive these values from user input.
   */
  loadableLangChainPrefixes?: readonly (readonly string[])[];
}

export class JsonPlusSerializer implements SerializerProtocol {
  private readonly loadableLangChainPrefixes: readonly (readonly string[])[];

  constructor(options?: JsonPlusSerializerOptions) {
    this.loadableLangChainPrefixes = [
      ...DEFAULT_LOADABLE_LC_PREFIXES,
      ...(options?.loadableLangChainPrefixes ?? []),
    ];
  }

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
    return _reviver(parsed, this.loadableLangChainPrefixes);
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

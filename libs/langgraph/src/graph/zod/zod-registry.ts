import { getInteropZodDefaultGetter } from "@langchain/core/utils/types";
import { $ZodType, $ZodRegistry, $replace } from "zod/v4/core";
import { SchemaMeta, SchemaMetaRegistry, schemaMetaRegistry } from "./meta.js";

/**
 * A Zod v4-compatible meta registry that extends the base registry.
 *
 * This registry allows you to associate and retrieve metadata for Zod schemas,
 * leveraging the base registry for storage. It is compatible with Zod v4 and
 * interoperates with the base registry to ensure consistent metadata management
 * across different Zod versions.
 *
 * @template Meta - The type of metadata associated with each schema.
 * @template Schema - The Zod schema type.
 */
export class LanggraphZodMetaRegistry<
  Meta extends SchemaMeta = SchemaMeta,
  Schema extends $ZodType = $ZodType
> extends $ZodRegistry<Meta, Schema> {
  /**
   * Creates a new LanggraphZodMetaRegistry instance.
   *
   * @param parent - The base SchemaMetaRegistry to use for metadata storage.
   */
  constructor(protected parent: SchemaMetaRegistry) {
    super();
    // Use the parent's map for metadata storage
    this._map = this.parent._map as WeakMap<Schema, $replace<Meta, Schema>>;
  }

  add<S extends Schema>(
    schema: S,
    ..._meta: undefined extends Meta
      ? [$replace<Meta, S>?]
      : [$replace<Meta, S>]
  ): this {
    const firstMeta = _meta[0];
    if (firstMeta && !firstMeta?.default) {
      const defaultValueGetter = getInteropZodDefaultGetter(schema);
      if (defaultValueGetter != null) {
        // eslint-disable-next-line no-param-reassign
        firstMeta.default = defaultValueGetter;
      }
    }
    return super.add(schema, ..._meta);
  }
}

export const registry = new LanggraphZodMetaRegistry(schemaMetaRegistry);

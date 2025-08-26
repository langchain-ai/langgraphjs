// @ts-expect-error If zod/v4 is not imported, the module augmentation will fail in build
import type { ZodType } from "zod/v4"; // eslint-disable-line @typescript-eslint/no-unused-vars

// @ts-expect-error If zod/v4-mini is not imported, the module augmentation will fail in build
import type { ZodMiniType } from "zod/v4-mini"; // eslint-disable-line @typescript-eslint/no-unused-vars

import type * as core from "zod/v4/core";
import { getInteropZodDefaultGetter } from "@langchain/core/utils/types";
import { $ZodType, $ZodRegistry, $replace } from "zod/v4/core";
import {
  type ReducedZodChannel,
  type SchemaMeta,
  type SchemaMetaRegistry,
  schemaMetaRegistry,
} from "./meta.js";

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
> extends $ZodRegistry<Meta & { [key: string]: unknown }, Schema> {
  /**
   * Creates a new LanggraphZodMetaRegistry instance.
   *
   * @param parent - The base SchemaMetaRegistry to use for metadata storage.
   */
  constructor(protected parent: SchemaMetaRegistry) {
    super();
    // Use the parent's map for metadata storage
    this._map = this.parent._map as WeakMap<
      Schema,
      $replace<Meta & { [key: string]: unknown }, Schema>
    >;
  }

  add<S extends Schema>(
    schema: S,
    ..._meta: undefined extends Meta & { [key: string]: unknown }
      ? [$replace<Meta & { [key: string]: unknown }, S>?]
      : [$replace<Meta & { [key: string]: unknown }, S>]
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

// Augment the zod/v4 module nudging the `register` method
// to use the user provided input schema if specified.
declare module "zod/v4" {
  export interface ZodType<
    out Output = unknown,
    out Input = unknown,
    out Internals extends core.$ZodTypeInternals<
      Output,
      Input
    > = core.$ZodTypeInternals<Output, Input>
  > extends core.$ZodType<Output, Input, Internals> {
    register<
      R extends LanggraphZodMetaRegistry,
      TOutput = core.output<this>,
      TInput = core.input<this>,
      TInternals extends core.$ZodTypeInternals<
        TOutput,
        TInput
      > = core.$ZodTypeInternals<TOutput, TInput>
    >(
      registry: R,
      meta: SchemaMeta<TOutput, TInput>
    ): ReducedZodChannel<this, ZodType<TOutput, TInput, TInternals>>;
  }
}

declare module "zod/v4-mini" {
  export interface ZodMiniType<
    out Output = unknown,
    out Input = unknown,
    out Internals extends core.$ZodTypeInternals<
      Output,
      Input
    > = core.$ZodTypeInternals<Output, Input>
  > extends core.$ZodType<Output, Input, Internals> {
    register<
      R extends LanggraphZodMetaRegistry,
      TOutput = core.output<this>,
      TInput = core.input<this>,
      TInternals extends core.$ZodTypeInternals<
        TOutput,
        TInput
      > = core.$ZodTypeInternals<TOutput, TInput>
    >(
      registry: R,
      meta: SchemaMeta<TOutput, TInput>
    ): ReducedZodChannel<this, ZodMiniType<TOutput, TInput, TInternals>>;
  }
}

export const registry = new LanggraphZodMetaRegistry(schemaMetaRegistry);

import { z } from "zod";

const AuthConfigSchema = z.object({
  path: z.string().optional(),
  disable_studio_auth: z.boolean().default(false),
});

const IndexConfigSchema = z.object({
  dims: z.number().optional(),
  embed: z.string().optional(),
  fields: z.array(z.string()).optional(),
});

const StoreConfigSchema = z.object({
  index: IndexConfigSchema.optional(),
});

const BaseConfigSchema = z.object({
  docker_compose_file: z.string().optional(),
  dockerfile_lines: z.array(z.string()).default([]),
  graphs: z.record(z.string()),
  env: z
    .union([z.array(z.string()), z.record(z.string()), z.string()])
    .default({}),
  store: StoreConfigSchema.optional(),
  _INTERNAL_docker_tag: z.string().optional(),
  auth: AuthConfigSchema.optional(),
});

const PythonConfigSchema = BaseConfigSchema.merge(
  z.object({
    python_version: z
      .union([z.literal("3.11"), z.literal("3.12")])
      .default("3.11"),
    pip_config_file: z.string().optional(),
    dependencies: z
      .array(z.string())
      .nonempty("You need to specify at least one dependency"),
  })
);

const NodeConfigSchema = BaseConfigSchema.merge(
  z.object({ node_version: z.literal("20").default("20") })
);

const ConfigSchema = z.union([NodeConfigSchema, PythonConfigSchema]);

export type PythonConfig = z.infer<typeof PythonConfigSchema>;
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export type Config = z.infer<typeof ConfigSchema>;
import * as path from "node:path";

export type InputNodeConfig = z.input<typeof NodeConfigSchema>;
export type InputPythonConfig = z.input<typeof PythonConfigSchema>;
export type InputConfig = z.input<typeof ConfigSchema>;

const PYTHON_EXTENSIONS = [".py", ".pyx", ".pyd", ".pyi"];

// TODO: implement this in Python CLI
export const getConfig = (config: InputConfig | string) => {
  const rawConfig = typeof config === "string" ? JSON.parse(config) : config;
  const { graphs } = BaseConfigSchema.parse(rawConfig);

  const preferPython = Object.values(graphs).every((i) =>
    PYTHON_EXTENSIONS.includes(path.extname(i.split(":")[0]))
  );

  if (preferPython) {
    return z.union([PythonConfigSchema, NodeConfigSchema]).parse(rawConfig);
  }

  return z.union([NodeConfigSchema, PythonConfigSchema]).parse(rawConfig);
};

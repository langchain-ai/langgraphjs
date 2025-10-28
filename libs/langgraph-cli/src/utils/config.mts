import { z } from "zod/v3";
import { extname } from "node:path";

const GraphPathSchema = z.string().refine((i) => i.includes(":"), {
  message: "Import string must be in format '<file>:<export>'",
});

const BaseConfigSchema = z.object({
  docker_compose_file: z.string().optional(),
  dockerfile_lines: z.array(z.string()).default([]),
  graphs: z.record(
    z.union([
      GraphPathSchema,
      z.object({
        path: GraphPathSchema,
        description: z.string().optional(),
      }),
    ])
  ),
  ui: z.record(z.string()).optional(),
  ui_config: z.object({ shared: z.array(z.string()).optional() }).optional(),
  _INTERNAL_docker_tag: z.string().optional(),
  env: z
    .union([z.array(z.string()), z.record(z.string()), z.string()])
    .default({}),
  store: z
    .object({
      index: z
        .object({
          dims: z.number().optional(),
          embed: z.string().optional(),
          fields: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  auth: z
    .object({
      path: z.string().optional(),
      disable_studio_auth: z.boolean().default(false),
    })
    .optional(),
  http: z
    .object({
      app: z.string().optional(),
      disable_assistants: z.boolean().default(false),
      disable_threads: z.boolean().default(false),
      disable_runs: z.boolean().default(false),
      disable_store: z.boolean().default(false),
      disable_meta: z.boolean().default(false),
      cors: z
        .object({
          allow_origins: z.array(z.string()).optional(),
          allow_methods: z.array(z.string()).optional(),
          allow_headers: z.array(z.string()).optional(),
          allow_credentials: z.boolean().optional(),
          allow_origin_regex: z.string().optional(),
          expose_headers: z.array(z.string()).optional(),
          max_age: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

const DEFAULT_PYTHON_VERSION = "3.11" as const;
const DEFAULT_NODE_VERSION = "20" as const;
const PYTHON_EXTENSIONS = [".py", ".pyx", ".pyd", ".pyi"];

const PythonVersionSchema = z.union([z.literal("3.11"), z.literal("3.12")]);
const NodeVersionSchema = z.union([z.literal("20"), z.literal("22")]);

const PythonConfigSchema = BaseConfigSchema.merge(
  z.object({
    pip_config_file: z.string().optional(),
    dependencies: z
      .array(z.string())
      .nonempty("You need to specify at least one dependency"),
  })
).merge(
  z.object({
    python_version: PythonVersionSchema.default(DEFAULT_PYTHON_VERSION),
    node_version: NodeVersionSchema.optional(),
  })
);

const NodeConfigSchema = BaseConfigSchema.merge(
  z.object({ node_version: NodeVersionSchema.default(DEFAULT_NODE_VERSION) })
);

const ConfigSchema = z.union([NodeConfigSchema, PythonConfigSchema]);
export type Config = z.infer<typeof ConfigSchema>;

// TODO: implement this in Python CLI
export const getConfig = (config: z.input<typeof ConfigSchema> | string) => {
  let input = typeof config === "string" ? JSON.parse(config) : config;
  const { graphs } = BaseConfigSchema.parse(input);

  const isPython = Object.values(graphs).map((graphDef) => {
    const importStr = typeof graphDef === "string" ? graphDef : graphDef.path;
    return PYTHON_EXTENSIONS.includes(extname(importStr.split(":")[0]));
  });
  const somePython = isPython.some((i) => i);
  const someNode = !isPython.every((i) => i);

  const node_version = someNode
    ? input.node_version || DEFAULT_NODE_VERSION
    : undefined;

  const python_version = somePython
    ? input.python_version || (someNode ? "3.12" : DEFAULT_PYTHON_VERSION)
    : undefined;

  if (node_version && python_version && python_version !== "3.12") {
    throw new Error("Only Python 3.12 is supported with Node.js");
  }

  input = { ...input, node_version, python_version };
  if (!input.node_version) delete input.node_version;
  if (!input.python_version) delete input.python_version;

  if (python_version) return PythonConfigSchema.parse(input);
  return NodeConfigSchema.parse(input);
};

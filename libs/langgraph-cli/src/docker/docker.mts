import dedent from "dedent";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { Config, NodeConfig, PythonConfig } from "../utils/config.mjs";

const dedenter = dedent.withOptions({ escapeSpecialCharacters: false });

interface LocalDeps {
  pipReqs: Array<[path: string, name: string]>;
  realPkgs: Record<string, string>;
  fauxPkgs: Record<string, [string, string]>;
  rebuildFiles: string[];
  workingDir?: string;
  reloadDir?: string;
}

async function exists(path: string) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function assembleLocalDeps(
  configPath: string,
  config: Config
): Promise<LocalDeps> {
  if ("node_version" in config) {
    const rebuildFiles: LocalDeps["rebuildFiles"] = [];
    const workingDir = `/deps/${path.basename(path.dirname(configPath))}`;

    rebuildFiles.push(path.resolve(path.dirname(configPath), "package.json"));
    rebuildFiles.push(
      path.resolve(path.dirname(configPath), "package-lock.json")
    );
    rebuildFiles.push(path.resolve(path.dirname(configPath), "yarn.lock"));
    rebuildFiles.push(path.resolve(path.dirname(configPath), "pnpm-lock.yaml"));

    return {
      pipReqs: [],
      realPkgs: {},
      fauxPkgs: {},
      rebuildFiles,
      workingDir,
    };
  }

  const reserved = new Set([
    "src",
    "langgraph-api",
    "langgraph_api",
    "langgraph",
    "langchain-core",
    "langchain_core",
    "pydantic",
    "orjson",
    "fastapi",
    "uvicorn",
    "psycopg",
    "httpx",
    "langsmith",
  ]);

  function checkReserved(name: string, ref: string) {
    if (reserved.has(name)) {
      throw new Error(
        `Package name '${name}' used in local dep '${ref}' is reserved. Rename the directory.`
      );
    }
    reserved.add(name);
  }

  const pipReqs: LocalDeps["pipReqs"] = [];
  const realPkgs: LocalDeps["realPkgs"] = {};
  const fauxPkgs: LocalDeps["fauxPkgs"] = {};
  const rebuildFiles: LocalDeps["rebuildFiles"] = [];
  let workingDir: string | undefined;
  let reloadDir: string | undefined;

  for (const localDep of config.dependencies) {
    if (!localDep.startsWith(".")) continue;

    const resolved = path.resolve(path.dirname(configPath), localDep);

    if (!(await exists(resolved))) {
      throw new Error(`Could not find local dependency: ${resolved}`);
    } else if (!(await fs.stat(resolved)).isDirectory()) {
      throw new Error(`Local dependency must be a directory: ${resolved}`);
    } else if (!resolved.startsWith(path.dirname(configPath))) {
      throw new Error(
        `Local dependency must be a subdirectory of the config file: ${resolved}`
      );
    }

    // if it's installable, add it to local_pkgs
    // otherwise, add it to faux_pkgs, and create a pyproject.toml
    const files = await fs.readdir(resolved);
    if (files.includes("pyproject.toml") || files.includes("setup.py")) {
      realPkgs[resolved] = localDep;
      if (localDep === ".") {
        workingDir = `/deps/${path.basename(resolved)}`;
      }

      if (files.includes("pyproject.toml")) {
        rebuildFiles.push(path.resolve(resolved, "pyproject.toml"));
      }

      if (files.includes("setup.py")) {
        rebuildFiles.push(path.resolve(resolved, "setup.py"));
      }
    } else {
      let containerPath: string;

      if (files.includes("__init__.py")) {
        // flat layout
        if (path.basename(resolved).includes("-")) {
          throw new Error(
            `Package name '${path.basename(resolved)}' contains a hyphen. Rename the directory to use it as flat-layout package.`
          );
        }

        checkReserved(path.basename(resolved), localDep);
        containerPath = `/deps/__outer_${path.basename(resolved)}/${path.basename(resolved)}`;
      } else {
        containerPath = `/deps/__outer_${path.basename(resolved)}/src`;
        for (const file of files) {
          const rfile = path.resolve(resolved, file);
          if (
            file !== "__pycache__" &&
            !file.startsWith(".") &&
            (await fs.stat(rfile)).isDirectory()
          ) {
            try {
              for (const subfile of await fs.readdir(rfile)) {
                if (subfile.endsWith(".py")) {
                  checkReserved(file, localDep);
                  break;
                }
              }
            } catch {
              // pass
            }
          }
        }
      }

      fauxPkgs[resolved] = [localDep, containerPath];
      if (localDep === ".") {
        workingDir = containerPath;
      } else {
        reloadDir = containerPath;
      }

      if (files.includes("requirements.txt")) {
        const rfile = path.resolve(resolved, "requirements.txt");
        rebuildFiles.push(rfile);

        pipReqs.push([
          path.relative(path.dirname(configPath), rfile),
          `${containerPath}/requirements.txt`,
        ]);
      }
    }
  }

  return { pipReqs, realPkgs, fauxPkgs, workingDir, reloadDir, rebuildFiles };
}

async function updateGraphPaths(
  configPath: string,
  config: Config,
  localDeps: LocalDeps
) {
  for (const [graphId, importStr] of Object.entries(config.graphs)) {
    let [moduleStr, attrStr] = importStr.split(":", 2);
    if (!moduleStr || !attrStr) {
      throw new Error(
        `Import string "${importStr}" must be in format "<module>:<attribute>".`
      );
    }

    if (moduleStr.includes("/")) {
      const resolved = path.resolve(path.dirname(configPath), moduleStr);
      if (!(await exists(resolved))) {
        throw new Error(`Could not find local module: ${resolved}`);
      } else if (!(await fs.stat(resolved)).isFile()) {
        throw new Error(`Local module must be a file: ${resolved}`);
      } else {
        find: {
          for (const realPath of Object.keys(localDeps.realPkgs)) {
            if (resolved.startsWith(realPath)) {
              moduleStr = `/deps/${path.basename(realPath)}/${path.relative(realPath, resolved)}`;
              break find;
            }
          }

          for (const [fauxPkg, [_, destPath]] of Object.entries(
            localDeps.fauxPkgs
          )) {
            if (resolved.startsWith(fauxPkg)) {
              moduleStr = `${destPath}/${path.relative(fauxPkg, resolved)}`;
              break find;
            }

            throw new Error(
              `Module '${importStr}' not found in 'dependencies' list. Add its containing package to 'dependencies' list.`
            );
          }
        }

        config["graphs"][graphId] = `${moduleStr}:${attrStr}`;
      }
    }
  }
}

export function getBaseImage(config: Config) {
  if ("python_version" in config) {
    return `langchain/langgraph-api:${config._INTERNAL_docker_tag || config.python_version}`;
  }

  if ("node_version" in config) {
    return `langchain/langgraphjs-api:${config._INTERNAL_docker_tag || config.node_version}`;
  }

  throw new Error("Invalid config type");
}

export async function configToDocker(
  configPath: string,
  config: Config,
  localDeps: LocalDeps,
  options?: {
    watch: boolean;
    dockerCommand?: string;
    onWorkingDir?: (workingDir: string | undefined) => void;
  }
) {
  if ("python_version" in config) {
    return pythonConfigToDocker(configPath, config, localDeps, options);
  }

  if ("node_version" in config) {
    return nodeConfigToDocker(configPath, config, localDeps, options);
  }

  throw new Error("Invalid config type");
}

export async function nodeConfigToDocker(
  configPath: string,
  config: NodeConfig,
  localDeps: LocalDeps,
  options?: {
    watch: boolean;
    onWorkingDir?: (workingDir: string | undefined) => void;
  }
) {
  // figure out the package manager used here
  const projectFolder = path.dirname(configPath);

  const testFile = async (file: string) =>
    fs
      .stat(path.resolve(projectFolder, file))
      .then((a) => a.isFile())
      .catch(() => false);

  const [npm, yarn, pnpm, bun] = await Promise.all([
    testFile("package-lock.json"),
    testFile("yarn.lock"),
    testFile("pnpm-lock.yaml"),
    testFile("bun.lockb"),
  ]);

  let installCmd = "npm i";

  if (yarn) {
    installCmd = "yarn install";
  } else if (pnpm) {
    installCmd = "pnpm i --frozen-lockfile";
  } else if (npm) {
    installCmd = "npm ci";
  } else if (bun) {
    installCmd = "bun i";
  }

  const lines: string[] = [
    `FROM ${getBaseImage(config)}`,
    ...config.dockerfile_lines,
    `ADD . ${localDeps.workingDir}`,
    `RUN cd ${localDeps.workingDir} && ${installCmd}`,
    `ENV LANGSERVE_GRAPHS='${JSON.stringify(config.graphs)}'`,
    ...(config.store
      ? [`ENV LANGGRAPH_STORE='${JSON.stringify(config.store)}'`]
      : []),
    ...(config.auth
      ? [`ENV LANGGRAPH_AUTH='${JSON.stringify(config.auth)}'`]
      : []),
    `WORKDIR ${localDeps.workingDir}`,
    `RUN (test ! -f /api/langgraph_api/js/build.mts && echo "Prebuild script not found, skipping") || tsx /api/langgraph_api/js/build.mts`,
  ];

  if (options?.watch) {
    // TODO: hacky, should add as entrypoint to the langgraph-api base image
    lines.push(
      `CMD exec uvicorn langgraph_api.server:app --log-config /api/logging.json --no-access-log --host 0.0.0.0 --port 8000 --reload --reload-dir ${localDeps.workingDir}`
    );
  }

  return lines.filter(Boolean).join("\n");
}

export async function pythonConfigToDocker(
  configPath: string,
  config: PythonConfig,
  localDeps: LocalDeps,
  options?: {
    watch: boolean;
    dockerCommand?: string;
    onWorkingDir?: (workingDir: string | undefined) => void;
  }
) {
  let pipInstall = `PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt`;
  if (config.pip_config_file) {
    pipInstall = `PIP_CONFIG_FILE=/pipconfig.txt ${pipInstall}`;
  }

  pipInstall = `--mount=type=cache,target=/root/.cache/pip ${pipInstall}`;

  const pipConfigFileStr = config.pip_config_file
    ? [`ADD ${config.pip_config_file} /pipconfig.txt`].join("\n")
    : "";

  const pypiDeps = config.dependencies.filter((dep) => !dep.startsWith("."));
  await updateGraphPaths(configPath, config, localDeps);

  const pipPkgsStr = pypiDeps.length
    ? `RUN ${pipInstall} ${pypiDeps.join(" ")}`
    : "";

  let pipReqStr: string;
  if (localDeps.pipReqs.length) {
    const pipReqsStr = localDeps.pipReqs
      .map(([reqpath, destpath]) => `ADD ${reqpath} ${destpath}`)
      .join("\n");
    pipReqStr = `${pipReqsStr}\nRUN ${pipInstall} ${localDeps.pipReqs.map(([, r]) => `-r ${r}`)}`;
  } else {
    pipReqStr = "";
  }

  const localPkgStr = Object.entries(localDeps.realPkgs)
    .map(
      ([fullpath, relpath]) => `ADD ${relpath} /deps/${path.basename(fullpath)}`
    )
    .join("\n");

  const fauxPkgsStr = Object.entries(localDeps.fauxPkgs)
    .map(([fullpath, [relpath, destpath]]) => {
      const x = dedenter`
        ADD ${relpath} ${destpath}
        RUN set -ex && \
            for line in '[project]' \
                        'name = "${path.basename(fullpath)}"' \
                        'version = "0.1"' \
                        '[tool.setuptools.package-data]' \
                        '"*" = ["**/*"]'; do \
                echo "${options?.dockerCommand === "build" ? "$line" : "$$line"}" >> /deps/__outer_${path.basename(fullpath)}/pyproject.toml; \
            done
      `;

      return x;
    })
    .join("\n");

  const lines = [
    `FROM ${getBaseImage(config)}`,
    ...config.dockerfile_lines,
    pipConfigFileStr,
    pipPkgsStr,
    pipReqStr,
    localPkgStr,
    fauxPkgsStr,
    `RUN ${pipInstall} -e /deps/*`,
    `ENV LANGSERVE_GRAPHS='${JSON.stringify(config.graphs)}'`,
    ...(config.store
      ? [`ENV LANGGRAPH_STORE='${JSON.stringify(config.store)}'`]
      : []),
    ...(config.auth
      ? [`ENV LANGGRAPH_AUTH='${JSON.stringify(config.auth)}'`]
      : []),
    localDeps.workingDir ? `WORKDIR ${localDeps.workingDir}` : null,
  ];

  if (options?.watch && (localDeps.workingDir || localDeps.reloadDir)) {
    // TODO: hacky, should add as entrypoint to the langgraph-api base image
    lines.push(
      `CMD exec uvicorn langgraph_api.server:app --log-config /api/logging.json --no-access-log --host 0.0.0.0 --port 8000 --reload --reload-dir ${localDeps.workingDir || localDeps.reloadDir}`
    );
  }

  return lines.filter(Boolean).join("\n");
}

export async function configToWatch(configPath: string, config: Config) {
  const localDeps = await assembleLocalDeps(configPath, config);
  const projectDir = path.dirname(configPath);
  const watch: Array<{
    path: string;
    action: "sync" | "rebuild";
    target?: string;
    ignore?: string[];
  }> = [];

  const watchSources =
    "python_version" in config
      ? config.dependencies.filter((dep) => dep.startsWith("."))
      : ["."];

  const watchIgnore =
    "node_version" in config
      ? ["node_modules", "langgraph.json"]
      : ["langgraph.json"];

  if (typeof config.env === "string") {
    watchIgnore.push(config.env);
  }

  for (const absPath of localDeps.rebuildFiles) {
    const relative = path.relative(projectDir, absPath);
    if (watch.find((i) => i.path === relative)) continue;
    watch.push({ path: relative, action: "rebuild" });
    watchIgnore.push(relative);
  }

  for (const source of watchSources) {
    const target = localDeps.workingDir || localDeps.reloadDir;
    watch.push({
      path: source,
      action: target ? "sync" : "rebuild",
      target: target,
      ignore: watchIgnore,
    });
  }

  if (watch.length > 0) return watch;
  return undefined;
}

export async function configToCompose(
  configPath: string,
  config: Config,
  options?: {
    watch: boolean;
    extendEnv?: Record<string, string>;
  }
): Promise<{
  apiDef: Record<string, unknown>;
  rewrite: { source: string; target: string } | undefined;
}> {
  const result: any = {};
  const localDeps = await assembleLocalDeps(configPath, config);
  const inline = await configToDocker(configPath, config, localDeps, options);

  result.pull_policy = "build";
  result.build = {
    context: ".",
    dockerfile_inline: inline + "\n",
  };

  const extendEnvIgnore = new Set<string>();
  if (typeof config.env === "string") {
    // try to parse out the env file
    const envPath = path.resolve(path.dirname(configPath), config.env);

    try {
      const envFileKeys = (await fs.readFile(envPath, "utf-8"))
        .split("\n")
        .map((lines) => lines.trim().split("=").at(0));

      for (const key of envFileKeys) {
        if (key) extendEnvIgnore.add(key);
      }
    } catch {
      throw new Error(`Could not read env file: ${envPath}`);
    }

    result.env_file = config.env;
  } else if (!Array.isArray(config.env)) {
    Object.entries(config.env).forEach(([k, v]) => {
      result.environment ??= {};
      result.environment[k] = v;
      extendEnvIgnore.add(k);
    });
  }

  if (options?.watch) {
    const watch = await configToWatch(configPath, config);
    if (watch) result.develop = { watch };
  }

  if (options?.extendEnv) {
    Object.entries(options.extendEnv).forEach(([k, v]) => {
      if (extendEnvIgnore.has(k)) return;
      result.environment ??= {};
      result.environment[k] = v;
    });
  }

  if (Array.isArray(config.env)) {
    // check if all the environment variables are present or not
    const missing = config.env.filter((k) => !result.environment?.[k]);
    if (missing.length)
      throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  return {
    apiDef: result,
    rewrite: localDeps.workingDir
      ? { source: path.dirname(configPath), target: localDeps.workingDir }
      : undefined,
  };
}

import dedent from "dedent";
import { describe, expect, it } from "vitest";
import {
  assembleLocalDeps,
  configToCompose,
  configToDocker,
  configToWatch,
} from "../src/docker/docker.mjs";
import { type Config, getConfig } from "../src/utils/config.mjs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as yaml from "yaml";

const dedenter = dedent.withOptions({ escapeSpecialCharacters: false });

const DEFAULT_CONFIG = {
  dockerfile_lines: [],
  env: {},
  python_version: "3.11" as const,
  pip_config_file: undefined,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("config to watch", () => {
  it("python e2e", async () => {
    const config = getConfig({
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs: { agent: "./agent.py:graph" },
      env: ".env",
      dockerfile_lines: [],
    });

    const localDeps = await assembleLocalDeps(
      path.resolve(__dirname, "./unit_tests/langgraph.json"),
      config
    );

    const watch = await configToWatch(
      path.resolve(__dirname, "./unit_tests/langgraph.json"),
      config,
      localDeps
    );

    expect(watch).toEqual([
      {
        action: "sync",
        ignore: ["langgraph.json", ".env"],
        path: ".",
        target: "/deps/__outer_unit_tests/unit_tests",
      },
    ]);
  });

  it("js e2e", async () => {
    const config = getConfig({
      ...DEFAULT_CONFIG,
      node_version: "20",
      dockerfile_lines: [],
      graphs: { agent: "./graphs/agent.js:graph" },
      env: ".env",
    });

    const localDeps = await assembleLocalDeps(
      path.resolve(__dirname, "./unit_tests/langgraph.json"),
      config
    );

    const watch = await configToWatch(
      path.resolve(__dirname, "./unit_tests/langgraph.json"),
      config,
      localDeps
    );

    expect(watch).toEqual([
      { action: "rebuild", path: "package.json" },
      { action: "rebuild", path: "package-lock.json" },
      { action: "rebuild", path: "yarn.lock" },
      { action: "rebuild", path: "pnpm-lock.yaml" },
      { action: "rebuild", path: "bun.lockb" },
      {
        action: "sync",
        ignore: [
          "node_modules",
          "langgraph.json",
          ".env",
          "package.json",
          "package-lock.json",
          "yarn.lock",
          "pnpm-lock.yaml",
          "bun.lockb",
        ],
        path: ".",
        target: "/deps/unit_tests",
      },
    ]);
  });
});

describe("config to docker", () => {
  const PATH_TO_CONFIG = path.resolve(__dirname, "./unit_tests/langgraph.json");

  it("simple", async () => {
    const graphs = { agent: "./agent.py:graph" };
    const config = getConfig({
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs,
    });

    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    expect(actual).toEqual(dedenter`
      FROM langchain/langgraph-api:3.11
      ADD . /deps/__outer_unit_tests/unit_tests
      RUN set -ex && \
          for line in '[project]' \
                      'name = "unit_tests"' \
                      'version = "0.1"' \
                      '[tool.setuptools.package-data]' \
                      '"*" = ["**/*"]'; do \
              echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
          done
      RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
      ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_unit_tests/unit_tests/agent.py:graph"}'
      WORKDIR /deps/__outer_unit_tests/unit_tests
    `);
  });

  it("pipconfig", async () => {
    const graphs = { agent: "./agent.py:graph" };
    const config = getConfig({
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs,
      pip_config_file: "pipconfig.txt",
    });
    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    expect(actual).toEqual(dedenter`
      FROM langchain/langgraph-api:3.11
      ADD pipconfig.txt /pipconfig.txt
      ADD . /deps/__outer_unit_tests/unit_tests
      RUN set -ex && \
          for line in '[project]' \
                      'name = "unit_tests"' \
                      'version = "0.1"' \
                      '[tool.setuptools.package-data]' \
                      '"*" = ["**/*"]'; do \
              echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
          done
      RUN --mount=type=cache,target=/root/.cache/pip PIP_CONFIG_FILE=/pipconfig.txt PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
      ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_unit_tests/unit_tests/agent.py:graph"}'
      WORKDIR /deps/__outer_unit_tests/unit_tests
    `);
  });

  it("invalid inputs", async () => {
    // test missing local dependencies
    await expect(async () => {
      const graphs = { agent: "./agent.py:graph" };
      const config = getConfig({
        ...DEFAULT_CONFIG,
        dependencies: ["./missing"],
        graphs,
      });

      await configToDocker(
        PATH_TO_CONFIG,
        config,
        await assembleLocalDeps(PATH_TO_CONFIG, config)
      );
    }).rejects.toThrowError(/Could not find local dependency/);

    // test missing local module
    await expect(async () => {
      const graphs = { agent: "./missing.py:graph" };
      const config = getConfig({
        ...DEFAULT_CONFIG,
        dependencies: ["."],
        graphs,
      });

      await configToDocker(
        PATH_TO_CONFIG,
        config,
        await assembleLocalDeps(PATH_TO_CONFIG, config)
      );
    }).rejects.toThrowError(/Could not find local module/);
  });

  it("local deps", async () => {
    const graphs = { agent: "./graphs/agent.py:graph" };
    const config = getConfig({
      ...DEFAULT_CONFIG,
      dependencies: ["./graphs"],
      graphs,
    });

    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    expect(actual).toEqual(dedenter`
      FROM langchain/langgraph-api:3.11
      ADD ./graphs /deps/__outer_graphs/src
      RUN set -ex && \
          for line in '[project]' \
                      'name = "graphs"' \
                      'version = "0.1"' \
                      '[tool.setuptools.package-data]' \
                      '"*" = ["**/*"]'; do \
              echo "$$line" >> /deps/__outer_graphs/pyproject.toml; \
          done
      RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
      ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_graphs/src/agent.py:graph"}'
    `);
  });

  it("pyproject", async () => {
    const pyproject = path.resolve(__dirname, "./unit_tests/pyproject.toml");
    await fs.writeFile(
      pyproject,
      dedenter`
        [project]
        name = "custom"
        version = "0.1"
        dependencies = ["langchain"]
      `,
      { encoding: "utf-8" }
    );

    const graphs = { agent: "./graphs/agent.py:graph" };
    const config = getConfig({
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs,
    });

    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    await fs.rm(pyproject);
    expect(actual).toEqual(dedenter`
      FROM langchain/langgraph-api:3.11
      ADD . /deps/unit_tests
      RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
      ENV LANGSERVE_GRAPHS='{"agent":"/deps/unit_tests/graphs/agent.py:graph"}'
      WORKDIR /deps/unit_tests
    `);
  });

  it("e2e", async () => {
    const graphs = { agent: "./graphs/agent.py:graph" };
    const config = getConfig({
      python_version: "3.12" as const,
      dependencies: ["./graphs/", "langchain", "langchain_openai"],
      graphs: graphs,
      pip_config_file: "pipconfig.txt",
      dockerfile_lines: ["ARG woof", "ARG foo"],
      env: {},
    });

    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    expect(actual).toEqual(dedenter`
      FROM langchain/langgraph-api:3.12
      ARG woof
      ARG foo
      ADD pipconfig.txt /pipconfig.txt
      RUN --mount=type=cache,target=/root/.cache/pip PIP_CONFIG_FILE=/pipconfig.txt PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt langchain langchain_openai
      ADD ./graphs/ /deps/__outer_graphs/src
      RUN set -ex && \
          for line in '[project]' \
                      'name = "graphs"' \
                      'version = "0.1"' \
                      '[tool.setuptools.package-data]' \
                      '"*" = ["**/*"]'; do \
              echo "$$line" >> /deps/__outer_graphs/pyproject.toml; \
          done
      RUN --mount=type=cache,target=/root/.cache/pip PIP_CONFIG_FILE=/pipconfig.txt PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
      ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_graphs/src/agent.py:graph"}'
    `);
  });

  it("js", async () => {
    const graphs = { agent: "./graphs/agent.js:graph" };
    const config = getConfig({
      dockerfile_lines: [],
      env: {},
      node_version: "20" as const,
      graphs,
    });

    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    // TODO: add support for any packager
    expect(actual).toEqual(dedenter`
      FROM langchain/langgraphjs-api:20
      ADD . /deps/unit_tests
      ENV LANGSERVE_GRAPHS='{"agent":"./graphs/agent.js:graph"}'
      WORKDIR /deps/unit_tests
      RUN npm i
      RUN (test ! -f /api/langgraph_api/js/build.mts && echo "Prebuild script not found, skipping") || tsx /api/langgraph_api/js/build.mts
    `);
  });

  it("description", async () => {
    const graphs = {
      agent: { path: "./graphs/agent.js:graph", description: "My agent" },
    };
    const config = getConfig({
      ...DEFAULT_CONFIG,
      env: {},
      node_version: "20" as const,
      graphs,
    });

    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    expect(actual).toEqual(dedenter`
      FROM langchain/langgraphjs-api:20
      ADD . /deps/unit_tests
      ENV LANGSERVE_GRAPHS='{"agent":{"path":"./graphs/agent.js:graph","description":"My agent"}}'
      WORKDIR /deps/unit_tests
      RUN npm i
      RUN (test ! -f /api/langgraph_api/js/build.mts && echo "Prebuild script not found, skipping") || tsx /api/langgraph_api/js/build.mts
    `);
  });
});

describe("config to compose", () => {
  const PATH_TO_CONFIG = path.resolve(__dirname, "./unit_tests/langgraph.json");

  it("simple", async () => {
    const graph = { agent: "./agent.py:graph" };
    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraph-api:3.11
            ADD . /deps/__outer_unit_tests/unit_tests
            RUN set -ex && \
                for line in '[project]' \
                            'name = "unit_tests"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_unit_tests/unit_tests/agent.py:graph"}'
            WORKDIR /deps/__outer_unit_tests/unit_tests
      ` + "\n";

    const { apiDef: actual, rewrite } = await configToCompose(PATH_TO_CONFIG, {
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs: graph,
    });

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining(path.join("/tests/unit_tests")),
      target: "/deps/__outer_unit_tests/unit_tests",
    });
  });

  it("env vars", async () => {
    const graph = { agent: "./agent.py:graph" };
    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraph-api:3.11
            ADD . /deps/__outer_unit_tests/unit_tests
            RUN set -ex && \
                for line in '[project]' \
                            'name = "unit_tests"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_unit_tests/unit_tests/agent.py:graph"}'
            WORKDIR /deps/__outer_unit_tests/unit_tests
        environment:
          OPENAI_API_KEY: key
    ` + "\n";

    const openai_api_key = "key";
    const { apiDef: actual, rewrite } = await configToCompose(PATH_TO_CONFIG, {
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs: graph,
      env: { OPENAI_API_KEY: openai_api_key },
    });

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining(path.join("/tests/unit_tests")),
      target: "/deps/__outer_unit_tests/unit_tests",
    });
  });

  it("env file", async () => {
    const graph = { agent: "./agent.py:graph" };
    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraph-api:3.11
            ADD . /deps/__outer_unit_tests/unit_tests
            RUN set -ex && \
                for line in '[project]' \
                            'name = "unit_tests"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_unit_tests/unit_tests/agent.py:graph"}'
            WORKDIR /deps/__outer_unit_tests/unit_tests
        env_file: .env
    ` + "\n";

    const { apiDef: actual, rewrite } = await configToCompose(PATH_TO_CONFIG, {
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs: graph,
      env: ".env",
    });

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining(path.join("/tests/unit_tests")),
      target: "/deps/__outer_unit_tests/unit_tests",
    });
  });

  it("watch", async () => {
    const graph = { agent: "./agent.py:graph" };
    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraph-api:3.11
            ADD . /deps/__outer_unit_tests/unit_tests
            RUN set -ex && \
                for line in '[project]' \
                            'name = "unit_tests"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_unit_tests/unit_tests/agent.py:graph"}'
            WORKDIR /deps/__outer_unit_tests/unit_tests
            CMD exec uvicorn langgraph_api.server:app --log-config /api/logging.json --no-access-log --host 0.0.0.0 --port 8000 --reload --reload-dir /deps/__outer_unit_tests/unit_tests
        develop:
          watch:
            - path: .
              action: sync
              target: /deps/__outer_unit_tests/unit_tests
              ignore:
                - langgraph.json
    ` + "\n";

    const { apiDef: actual, rewrite } = await configToCompose(
      PATH_TO_CONFIG,
      {
        ...DEFAULT_CONFIG,
        dependencies: ["."],
        graphs: graph,
      },
      { watch: true }
    );

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining(path.join("/tests/unit_tests")),
      target: "/deps/__outer_unit_tests/unit_tests",
    });
  });

  it("env", async () => {
    const PATH_TO_CONFIG = path.resolve(
      __dirname,
      "./env_tests/langgraph.json"
    );

    const graph = { agent: "./agent.py:graph" };
    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraph-api:3.11
            ADD . /deps/__outer_env_tests/env_tests
            RUN set -ex && \
                for line in '[project]' \
                            'name = "env_tests"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_env_tests/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_env_tests/env_tests/agent.py:graph"}'
            WORKDIR /deps/__outer_env_tests/env_tests
            CMD exec uvicorn langgraph_api.server:app --log-config /api/logging.json --no-access-log --host 0.0.0.0 --port 8000 --reload --reload-dir /deps/__outer_env_tests/env_tests
        develop:
          watch:
            - path: .
              action: sync
              target: /deps/__outer_env_tests/env_tests
              ignore:
                - langgraph.json
        environment:
          ANTHROPIC_API_KEY: key
          OPENAI_API_KEY: key
      ` + "\n";

    const { apiDef: actual, rewrite } = await configToCompose(
      PATH_TO_CONFIG,
      {
        ...DEFAULT_CONFIG,
        dependencies: ["."],
        graphs: graph,
        env: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        dockerfile_lines: [],
      },
      {
        watch: true,
        extendEnv: { ANTHROPIC_API_KEY: "key", OPENAI_API_KEY: "key" },
      }
    );

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining(path.join("/tests/env_tests")),
      target: "/deps/__outer_env_tests/env_tests",
    });
  });

  it("env missing", async () => {
    await expect(() =>
      configToCompose(
        path.resolve(__dirname, "./env_tests/langgraph.json"),
        {
          ...DEFAULT_CONFIG,
          dependencies: ["."],
          graphs: { agent: "./agent.py:graph" },
          env: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
          dockerfile_lines: [],
        },
        { watch: true }
      )
    ).rejects.toThrowError(
      /Missing environment variables: OPENAI_API_KEY, ANTHROPIC_API_KEY/
    );
  });

  it("multilanguage", async () => {
    const graphs = {
      python: "./graphs/agent.py:graph",
      js: "./graphs/agent.js:graph",
    };
    const config = getConfig({
      dockerfile_lines: [],
      env: {},
      node_version: "20" as const,
      python_version: "3.12" as const,
      graphs,
      dependencies: ["."],
    });

    const { apiDef: actual } = await configToCompose(PATH_TO_CONFIG, config, {
      watch: false,
    });

    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraphjs-api:20
            ADD . /deps/__outer_unit_tests/unit_tests
            RUN set -ex && \
                for line in '[project]' \
                            'name = "unit_tests"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"python":"/deps/__outer_unit_tests/unit_tests/graphs/agent.py:graph","js":"/deps/__outer_unit_tests/unit_tests/graphs/agent.js:graph"}'
            WORKDIR /deps/__outer_unit_tests/unit_tests
            RUN npm i
            RUN (test ! -f /api/langgraph_api/js/build.mts && echo "Prebuild script not found, skipping") || tsx /api/langgraph_api/js/build.mts
        ` + "\n";

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
  });

  it("e2e", async () => {
    const graph = { agent: "./agent.py:graph" };
    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraph-api:3.11
            ADD . /deps/__outer_unit_tests/unit_tests
            RUN set -ex && \
                for line in '[project]' \
                            'name = "unit_tests"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_unit_tests/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_unit_tests/unit_tests/agent.py:graph"}'
            WORKDIR /deps/__outer_unit_tests/unit_tests
            CMD exec uvicorn langgraph_api.server:app --log-config /api/logging.json --no-access-log --host 0.0.0.0 --port 8000 --reload --reload-dir /deps/__outer_unit_tests/unit_tests
        env_file: .env
        develop:
          watch:
            - path: .
              action: sync
              target: /deps/__outer_unit_tests/unit_tests
              ignore:
                - langgraph.json
                - .env
      ` + "\n";

    const { apiDef: actual, rewrite } = await configToCompose(
      PATH_TO_CONFIG,
      {
        ...DEFAULT_CONFIG,
        dependencies: ["."],
        graphs: graph,
        env: ".env",
        dockerfile_lines: [],
      },
      { watch: true }
    );

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining(path.join("/tests/unit_tests")),
      target: "/deps/__outer_unit_tests/unit_tests",
    });
  });
});

describe("packaging", () => {
  async function loadConfig(
    rel: string
  ): Promise<[path: string, config: Config]> {
    const res = path.resolve(__dirname, rel);
    const config = getConfig(
      JSON.parse(await fs.readFile(res, { encoding: "utf-8" }))
    );
    return [res, config];
  }

  it("faux", async () => {
    const { apiDef: actual } = await configToCompose(
      ...(await loadConfig("./packaging_tests/faux/langgraph.json")),
      { watch: true }
    );

    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraph-api:3.11
            ADD my_agent/requirements.txt /deps/__outer_my_agent/my_agent/requirements.txt
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -r /deps/__outer_my_agent/my_agent/requirements.txt
            ADD ./my_agent /deps/__outer_my_agent/my_agent
            RUN set -ex && \
                for line in '[project]' \
                            'name = "my_agent"' \
                            'version = "0.1"' \
                            '[tool.setuptools.package-data]' \
                            '"*" = ["**/*"]'; do \
                    echo "$$line" >> /deps/__outer_my_agent/pyproject.toml; \
                done
            RUN --mount=type=cache,target=/root/.cache/pip PYTHONDONTWRITEBYTECODE=1 pip install -c /api/constraints.txt -e /deps/*
            ENV LANGSERVE_GRAPHS='{"agent":"/deps/__outer_my_agent/my_agent/agent.py:graph"}'
            CMD exec uvicorn langgraph_api.server:app --log-config /api/logging.json --no-access-log --host 0.0.0.0 --port 8000 --reload --reload-dir /deps/__outer_my_agent/my_agent
        env_file: .env
        develop:
          watch:
            - path: my_agent/requirements.txt
              action: rebuild
            - path: ./my_agent
              action: sync
              target: /deps/__outer_my_agent/my_agent
              ignore:
                - langgraph.json
                - .env
                - my_agent/requirements.txt
      ` + "\n";

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
  });

  it("js", async () => {
    const { apiDef: actual, rewrite } = await configToCompose(
      ...(await loadConfig("./packaging_tests/js/langgraph.json")),
      { watch: true }
    );

    const expected =
      dedenter`
        pull_policy: build
        build:
          context: .
          dockerfile_inline: |
            FROM langchain/langgraphjs-api:20
            ADD . /deps/js
            ENV LANGSERVE_GRAPHS='{"agent":"./route.ts:agent"}'
            WORKDIR /deps/js
            RUN npm i
            RUN (test ! -f /api/langgraph_api/js/build.mts && echo "Prebuild script not found, skipping") || tsx /api/langgraph_api/js/build.mts
            CMD exec uvicorn langgraph_api.server:app --log-config /api/logging.json --no-access-log --host 0.0.0.0 --port 8000 --reload --reload-dir /deps/js
        env_file: .env
        develop:
          watch:
            - path: package.json
              action: rebuild
            - path: package-lock.json
              action: rebuild
            - path: yarn.lock
              action: rebuild
            - path: pnpm-lock.yaml
              action: rebuild
            - path: bun.lockb
              action: rebuild
            - path: .
              action: sync
              target: /deps/js
              ignore:
                - node_modules
                - langgraph.json
                - .env
                - package.json
                - package-lock.json
                - yarn.lock
                - pnpm-lock.yaml
                - bun.lockb
      ` + "\n";

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining(path.join("/tests/packaging_tests/js")),
      target: "/deps/js",
    });
  });
});

it("node config and python config", () => {
  // node config
  expect(
    getConfig({
      node_version: "20",
      dockerfile_lines: [],
      dependencies: ["."],
      graphs: { agent: "./route.ts:agent" },
    })
  ).toEqual({
    node_version: "20",
    dockerfile_lines: [],
    graphs: { agent: "./route.ts:agent" },
    env: {},
  });

  // python config
  expect(
    getConfig({
      dockerfile_lines: [],
      env: {},
      python_version: "3.11" as const,
      pip_config_file: undefined,
      dependencies: ["."],
      graphs: { agent: "./agent.py:graph" },
    })
  ).toEqual({
    python_version: "3.11",
    pip_config_file: undefined,
    dockerfile_lines: [],
    dependencies: ["."],
    graphs: { agent: "./agent.py:graph" },
    env: {},
  });

  // default config
  expect(
    getConfig({
      dependencies: ["."],
      graphs: { agent: "./agent.py:graph" },
    })
  ).toEqual({
    python_version: "3.11",
    pip_config_file: undefined,
    dockerfile_lines: [],
    dependencies: ["."],
    graphs: { agent: "./agent.py:graph" },
    env: {},
  });

  // default node
  expect(getConfig({ graphs: { agent: "./agent.js:graph" } })).toEqual({
    node_version: "24",
    dockerfile_lines: [],
    graphs: { agent: "./agent.js:graph" },
    env: {},
  });

  // Default multiplatform
  expect(
    getConfig({
      dependencies: ["."],
      graphs: { js: "./agent.js:graph", py: "./agent.py:graph" },
    })
  ).toEqual({
    python_version: "3.12",
    node_version: "24",
    dependencies: ["."],
    graphs: { js: "./agent.js:graph", py: "./agent.py:graph" },
    dockerfile_lines: [],
    env: {},
  });

  // Invalid combination
  expect
    .soft(() =>
      getConfig({
        node_version: "20",
        python_version: "3.11",
        graphs: { agent: "./agent.py:graph", js: "./agent.js:graph" },
        dependencies: ["."],
      })
    )
    .toThrow("Only Python 3.12 is supported with Node.js");

  // Invalid graph import format
  expect
    .soft(() =>
      getConfig({
        graphs: { agent: "agent.py" },
        dependencies: ["."],
      })
    )
    .toThrow(`Import string must be in format '<file>:<export>'`);

  // Empty dependencies
  expect
    .soft(() =>
      getConfig({
        graphs: { agent: "./agent.py:graph" },
        // @ts-expect-error
        dependencies: [], // Empty array
      })
    )
    .toThrow("You need to specify at least one dependency");

  // Invalid Python version
  expect
    .soft(() =>
      getConfig({
        // @ts-expect-error
        python_version: "3.10", // Unsupported version
        graphs: { agent: "./agent.py:graph" },
        dependencies: ["."],
      })
    )
    .toThrow();

  // Invalid Node version (below minimum)
  expect
    .soft(() =>
      getConfig({
        node_version: "18", // Below minimum version
        graphs: { agent: "./agent.js:graph" },
      })
    )
    .toThrow("Node.js version must be >= 20");

  expect
    .soft(() =>
      getConfig({
        node_version: "19",
        graphs: { agent: "./agent.js:graph" },
      })
    )
    .toThrow("Node.js version must be >= 20");

  // Invalid Node version (not a number)
  expect
    .soft(() =>
      getConfig({
        node_version: "invalid",
        graphs: { agent: "./agent.js:graph" },
      })
    )
    .toThrow("Node.js version must be >= 20");
});

describe("node version validation", () => {
  it("accepts valid major versions >= 20", () => {
    // Version 20
    expect(
      getConfig({
        node_version: "20",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toMatchObject({ node_version: "20" });

    // Version 22
    expect(
      getConfig({
        node_version: "22",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toMatchObject({ node_version: "22" });

    // Version 24
    expect(
      getConfig({
        node_version: "24",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toMatchObject({ node_version: "24" });

    // Future version
    expect(
      getConfig({
        node_version: "26",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toMatchObject({ node_version: "26" });
  });

  it("accepts semver-style versions >= 20", () => {
    expect(
      getConfig({
        node_version: "20.10.0",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toMatchObject({ node_version: "20.10.0" });

    expect(
      getConfig({
        node_version: "22.1.5",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toMatchObject({ node_version: "22.1.5" });
  });

  it("rejects versions below minimum (20)", () => {
    expect(() =>
      getConfig({
        node_version: "18",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toThrow("Node.js version must be >= 20");

    expect(() =>
      getConfig({
        node_version: "16",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toThrow("Node.js version must be >= 20");

    expect(() =>
      getConfig({
        node_version: "19.9.0",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toThrow("Node.js version must be >= 20");
  });

  it("rejects invalid version strings", () => {
    expect(() =>
      getConfig({
        node_version: "invalid",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toThrow("Node.js version must be >= 20");

    expect(() =>
      getConfig({
        node_version: "abc.def.ghi",
        graphs: { agent: "./agent.js:graph" },
      })
    ).toThrow("Node.js version must be >= 20");
  });
});

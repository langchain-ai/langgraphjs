import dedent from "dedent";
import { describe, expect, it } from "vitest";
import {
  assembleLocalDeps,
  configToCompose,
  configToDocker,
  configToWatch,
} from "../src/docker/dockerfile.mjs";
import { type Config, ConfigSchema } from "../src/utils/config.mjs";
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
    const watch = await configToWatch(
      path.resolve(__dirname, "./unit_tests/langgraph.json"),
      {
        ...DEFAULT_CONFIG,
        dependencies: ["."],
        graphs: { agent: "./agent.py:graph" },
        env: ".env",
        dockerfile_lines: [],
      }
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
    const watch = await configToWatch(
      path.resolve(__dirname, "./unit_tests/langgraph.json"),
      {
        node_version: "20",
        dockerfile_lines: [],
        dependencies: ["."],
        graphs: { agent: "./route.ts:agent" },
        env: ".env",
      }
    );

    expect(watch).toEqual([
      { action: "rebuild", path: "package.json" },
      { action: "rebuild", path: "package-lock.json" },
      { action: "rebuild", path: "yarn.lock" },
      { action: "rebuild", path: "pnpm-lock.yaml" },
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
    const config: Config = {
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs,
    };

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
    const config: Config = {
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs,
      pip_config_file: "pipconfig.txt",
    };
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
      const config: Config = {
        ...DEFAULT_CONFIG,
        dependencies: ["./missing"],
        graphs,
      };

      await configToDocker(
        PATH_TO_CONFIG,
        config,
        await assembleLocalDeps(PATH_TO_CONFIG, config)
      );
    }).rejects.toThrowError(/Could not find local dependency/);

    // test missing local module
    await expect(async () => {
      const graphs = { agent: "./missing.py:graph" };
      const config: Config = {
        ...DEFAULT_CONFIG,
        dependencies: ["."],
        graphs,
      };

      await configToDocker(
        PATH_TO_CONFIG,
        config,
        await assembleLocalDeps(PATH_TO_CONFIG, config)
      );
    }).rejects.toThrowError(/Could not find local module/);
  });

  it("local deps", async () => {
    const graphs = { agent: "./graphs/agent.py:graph" };
    const config: Config = {
      ...DEFAULT_CONFIG,
      dependencies: ["./graphs"],
      graphs,
    };

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
    const config: Config = {
      ...DEFAULT_CONFIG,
      dependencies: ["."],
      graphs,
    };

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
    const config: Config = {
      python_version: "3.12" as const,
      dependencies: ["./graphs/", "langchain", "langchain_openai"],
      graphs: graphs,
      pip_config_file: "pipconfig.txt",
      dockerfile_lines: ["ARG woof", "ARG foo"],
      env: {},
    };

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
    const graphs = { agent: "./agent.js:graph" };
    const config: Config = {
      dockerfile_lines: [],
      env: {},
      node_version: "20" as const,
      graphs,
    };

    const actual = await configToDocker(
      PATH_TO_CONFIG,
      config,
      await assembleLocalDeps(PATH_TO_CONFIG, config)
    );

    // TODO: add support for any packager
    expect(actual).toEqual(dedenter`
      FROM langchain/langgraphjs-api:20
      ADD . /deps/unit_tests
      RUN cd /deps/unit_tests && npm i
      ENV LANGSERVE_GRAPHS='{"agent":"./agent.js:graph"}'
      WORKDIR /deps/unit_tests
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
      source: expect.stringContaining("/tests/unit_tests"),
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
      source: expect.stringContaining("/tests/unit_tests"),
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
      source: expect.stringContaining("/tests/unit_tests"),
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
      source: expect.stringContaining("/tests/unit_tests"),
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
      source: expect.stringContaining("/tests/env_tests"),
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
      source: expect.stringContaining("/tests/unit_tests"),
      target: "/deps/__outer_unit_tests/unit_tests",
    });
  });
});

describe("packaging", () => {
  async function loadConfig(
    rel: string
  ): Promise<[path: string, config: Config]> {
    const res = path.resolve(__dirname, rel);
    const config = ConfigSchema.parse(
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
            RUN cd /deps/js && npm i
            ENV LANGSERVE_GRAPHS='{"agent":"./route.ts:agent"}'
            WORKDIR /deps/js
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
      ` + "\n";

    expect(yaml.stringify(actual, { blockQuote: "literal" })).toEqual(expected);
    expect(rewrite).toMatchObject({
      source: expect.stringContaining("/tests/packaging_tests/js"),
      target: "/deps/js",
    });
  });
});

it("node config and python config", () => {
  // node config
  expect(
    ConfigSchema.parse({
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
    ConfigSchema.parse({
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
    ConfigSchema.parse({
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
});

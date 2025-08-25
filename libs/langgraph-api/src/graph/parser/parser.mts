import * as ts from "typescript";
import * as vfs from "@typescript/vfs";
import * as path from "node:path";
import dedent from "dedent";
import { fileURLToPath } from "node:url";
import type { JSONSchema7 } from "json-schema";
import { buildGenerator } from "./schema/types.mjs";

interface GraphSchema {
  state: JSONSchema7 | undefined;
  input: JSONSchema7 | undefined;
  output: JSONSchema7 | undefined;
  config: JSONSchema7 | undefined;
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const OVERRIDE_RESOLVE = [
  // Override `@langchain/langgraph` or `@langchain/langgraph/prebuilt`,
  // but not `@langchain/langgraph-sdk`
  new RegExp(`^@langchain\/langgraph(\/.+)?$`),
  new RegExp(`^@langchain\/langgraph-checkpoint(\/.+)?$`),
];

const INFER_TEMPLATE_PATH = path.resolve(
  __dirname,
  "./schema/types.template.mts"
);

export class SubgraphExtractor {
  protected program: ts.Program;

  protected checker: ts.TypeChecker;

  protected sourceFile: ts.SourceFile;

  protected inferFile: ts.SourceFile;

  protected anyPregelType: ts.Type;

  protected anyGraphType: ts.Type;

  protected strict: boolean;

  constructor(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    inferFile: ts.SourceFile,
    options?: { strict?: boolean }
  ) {
    this.program = program;
    this.sourceFile = sourceFile;
    this.inferFile = inferFile;

    this.checker = program.getTypeChecker();
    this.strict = options?.strict ?? false;

    this.anyPregelType = this.findTypeByName("AnyPregel");
    this.anyGraphType = this.findTypeByName("AnyGraph");
  }

  private findTypeByName = (needle: string) => {
    let result: ts.Type | undefined;

    const visit = (node: ts.Node) => {
      if (ts.isTypeAliasDeclaration(node)) {
        const {symbol} = (node as any);

        if (symbol != null) {
          const name = this.checker
            .getFullyQualifiedName(symbol)
            .replace(/".*"\./, "");
          if (name === needle) result = this.checker.getTypeAtLocation(node);
        }
      }
      if (result == null) ts.forEachChild(node, visit);
    };

    ts.forEachChild(this.inferFile, visit);
    if (!result) throw new Error(`Failed to find "${needle}" type`);
    return result;
  };

  private find = (
    root: ts.Node,
    predicate: (node: ts.Node) => boolean
  ): ts.Node | undefined => {
    let result: ts.Node | undefined;

    const visit = (node: ts.Node) => {
      if (predicate(node)) {
        result = node;
      } else {
        ts.forEachChild(node, visit);
      }
    };

    if (predicate(root)) return root;
    ts.forEachChild(root, visit);
    return result;
  };

  protected findSubgraphs = (
    node: ts.Node,
    namespace: string[] = []
  ): {
    node: string;
    namespace: string[];
    subgraph: { name: string; node: ts.Node };
  }[] => {
    const findAllAddNodeCalls = (
      acc: {
        node: string;
        namespace: string[];
        subgraph: { name: string; node: ts.Node };
      }[],
      node: ts.Node
    ) => {
      if (ts.isCallExpression(node)) {
        const firstChild = node.getChildAt(0);

        if (
          ts.isPropertyAccessExpression(firstChild) &&
          this.getText(firstChild.name) === "addNode"
        ) {
          let nodeName: string = "unknown";
          let variables: { node: ts.Node; name: string }[] = [];

          const [subgraphNode, callArg] = node.arguments;

          if (subgraphNode && ts.isStringLiteralLike(subgraphNode)) {
            nodeName = this.getText(subgraphNode);
            if (
              (nodeName.startsWith(`"`) && nodeName.endsWith(`"`)) ||
              (nodeName.startsWith(`'`) && nodeName.endsWith(`'`))
            ) {
              nodeName = nodeName.slice(1, -1);
            }
          }

          if (callArg) {
            if (
              ts.isFunctionLike(callArg) ||
              ts.isCallLikeExpression(callArg)
            ) {
              variables = this.reduceChildren(
                callArg,
                this.findSubgraphIdentifiers,
                []
              );
            } else if (ts.isIdentifier(callArg)) {
              variables = this.findSubgraphIdentifiers([], callArg);
            }
          }

          if (variables.length > 0) {
            if (variables.length > 1) {
              const targetName = [...namespace, nodeName].join("|");
              const errMsg = `Multiple unique subgraph invocations found for "${targetName}"`;
              if (this.strict) throw new Error(errMsg);
              console.warn(errMsg);
            }

            acc.push({
              namespace,
              node: nodeName,
              subgraph: variables[0],
            });
          }
        }
      }

      return acc;
    };

    let subgraphs = this.reduceChildren(node, findAllAddNodeCalls, []);

    // TODO: make this more strict, only traverse the flow graph only
    // if no `addNode` calls were found
    if (!subgraphs.length) {
      // internal property, however relied upon by ts-ast-viewer et all
      // so that we don't need to traverse the control flow ourselves
      // https://github.com/microsoft/TypeScript/pull/58036
      type InternalFlowNode = ts.Node & { flowNode?: { node: ts.Node } };
      const candidate = this.find(
        node,
        (node: any) => node && "flowNode" in node && node.flowNode
      ) as InternalFlowNode | undefined;

      if (
        candidate?.flowNode &&
        this.isGraphOrPregelType(
          this.checker.getTypeAtLocation(candidate.flowNode.node)
        )
      ) {
        subgraphs = this.findSubgraphs(candidate.flowNode.node, namespace);
      }
    }

    // handle recursive behaviour
    if (subgraphs.length > 0) {
      return [
        ...subgraphs,
        ...subgraphs.map(({ subgraph, node }) =>
          this.findSubgraphs(subgraph.node, [...namespace, node])
        ),
      ].flat();
    }

    return subgraphs;
  };

  protected getSubgraphsVariables = (name: string) => {
    const sourceSymbol = this.checker.getSymbolAtLocation(this.sourceFile)!;
    const exports = this.checker.getExportsOfModule(sourceSymbol);

    const targetExport = exports.find((item) => item.name === name);
    if (!targetExport) throw new Error(`Failed to find export "${name}"`);
    const varDecls = (targetExport.declarations ?? []).filter(
      ts.isVariableDeclaration
    );

    return varDecls.flatMap((varDecl) => {
      if (!varDecl.initializer) return [];
      return this.findSubgraphs(varDecl.initializer, [name]);
    });
  };

  public getAugmentedSourceFile = (
    sourcePath: string,
    name: string,
    options: { allowImportingTsExtensions: boolean }
  ): {
    inferFile: { fileName: string; contents: string };
    sourceFile: { fileName: string; contents: string };
    exports: { typeName: string; valueName: string; graphName: string }[];
  } => {
    function sanitize<T extends string>(input: T): T {
      return input.replace(/[^a-zA-Z0-9]/g, "_") as T;
    }

    const vars = this.getSubgraphsVariables(name);

    type TypeExport = {
      typeName: `__langgraph__${string}`;
      valueName: string;
      graphName: string;
    };

    const ext = path.extname(sourcePath);
    const suffix = sourcePath.slice(0, -ext.length);

    let typeExports: TypeExport[] = [
      {
        typeName: sanitize(`__langgraph__${name}_${suffix}`),
        valueName: name,
        graphName: name,
      },
    ];

    const seenTypeName = new Set<string>();
    for (const { subgraph, node, namespace } of vars) {
      if (seenTypeName.has(subgraph.name)) continue;
      seenTypeName.add(subgraph.name);

      typeExports.push({
        typeName: sanitize(
          `__langgraph__${namespace.join("_")}_${node}_${suffix}`
        ),
        valueName: subgraph.name,
        graphName: [...namespace, node].join("|"),
      });
    }

    typeExports = typeExports.map(({ typeName, ...rest }) => ({
      ...rest,
      typeName: sanitize(typeName),
    }));

    const sourceFilePath = `__langgraph__source_${sanitize(suffix)}${ext}`;
    const sourceContents = [
      this.getText(this.sourceFile),
      typeExports.map(
        (type) => `export type ${type.typeName} = typeof ${type.valueName}`
      ),
    ];

    const inferFilePath = `__langgraph__infer_${sanitize(suffix)}${ext}`;
    const sourceFileImportPath = options.allowImportingTsExtensions
      ? sourceFilePath
      : sourceFilePath.slice(0, -ext.length) + ext.replace("ts", "js");

    const inferContents = [
      typeExports.map(
        (type) =>
          `import type { ${type.typeName} } from "./${sourceFileImportPath}"`
      ),
      this.inferFile.getText(this.inferFile),
      typeExports.map(
        (type) => dedent`
          type ${type.typeName}__reflect = Reflect<${type.typeName}>;
          export type ${type.typeName}__state = Inspect<${type.typeName}__reflect["state"]>;
          export type ${type.typeName}__update = Inspect<${type.typeName}__reflect["update"]>;

          type ${type.typeName}__builder = BuilderReflect<${type.typeName}>;
          export type ${type.typeName}__input = Inspect<FilterAny<${type.typeName}__builder["input"]>>;
          export type ${type.typeName}__output = Inspect<FilterAny<${type.typeName}__builder["output"]>>;
          export type ${type.typeName}__config = Inspect<FilterAny<${type.typeName}__builder["config"]>>;
        `
      ),
    ];

    return {
      inferFile: {
        fileName: inferFilePath,
        contents: inferContents.flat(1).join("\n\n"),
      },
      sourceFile: {
        fileName: sourceFilePath,
        contents: sourceContents.flat(1).join("\n\n"),
      },
      exports: typeExports,
    };
  };

  protected findSubgraphIdentifiers = (
    acc: { node: ts.Node; name: string }[],
    node: ts.Node
  ) => {
    if (ts.isIdentifier(node)) {
      const smb = this.checker.getSymbolAtLocation(node);

      if (
        smb?.valueDeclaration &&
        ts.isVariableDeclaration(smb.valueDeclaration)
      ) {
        const target = smb.valueDeclaration;
        const targetType = this.checker.getTypeAtLocation(target);

        if (this.isGraphOrPregelType(targetType)) {
          acc.push({ name: this.getText(target.name), node: target });
        }
      }

      if (smb?.declarations) {
        const target = smb.declarations.find(ts.isImportSpecifier);
        if (target) {
          const targetType = this.checker.getTypeAtLocation(target);
          if (this.isGraphOrPregelType(targetType)) {
            acc.push({ name: this.getText(target.name), node: target });
          }
        }
      }
    }

    return acc;
  };

  protected isGraphOrPregelType = (type: ts.Type) => {
    return (
      this.checker.isTypeAssignableTo(type, this.anyPregelType) ||
      this.checker.isTypeAssignableTo(type, this.anyGraphType)
    );
  };

  protected getText(node: ts.Node) {
    return node.getText(this.sourceFile);
  }

  protected reduceChildren<Acc>(
    node: ts.Node,
    fn: (acc: Acc, node: ts.Node) => Acc,
    initial: Acc
  ): Acc {
    let acc = initial;
    function it(node: ts.Node) {
      acc = fn(acc, node);
      // @ts-expect-error
      ts.forEachChild(node, it.bind(this));
    }

    ts.forEachChild(node, it.bind(this));
    return acc;
  }

  static extractSchemas(
    target: {
      sourceFile:
        | string
        | {
            path: string;
            contents: string;
            main?: boolean;
          }[];
      exportSymbol: string;
    }[],
    options?: { strict?: boolean; tsConfigOptions?: Record<string, unknown> }
  ): Record<string, GraphSchema>[] {
    if (!target.length) throw new Error("No graphs found");

    function getCommonPath(a: string, b: string) {
      const aSeg = path.normalize(a).split(path.sep);
      const bSeg = path.normalize(b).split(path.sep);

      const maxIter = Math.min(aSeg.length, bSeg.length);
      const result: string[] = [];
      for (let i = 0; i < maxIter; ++i) {
        if (aSeg[i] !== bSeg[i]) break;
        result.push(aSeg[i]);
      }
      return result.join(path.sep);
    }

    const isTestTarget = (
      check: typeof target
    ): check is { sourceFile: string; exportSymbol: string }[] => {
      return check.every((x) => typeof x.sourceFile === "string");
    };

    const projectDirname = isTestTarget(target)
      ? target.reduce<string>((acc, item) => {
          if (!acc) return path.dirname(item.sourceFile);
          return getCommonPath(acc, path.dirname(item.sourceFile));
        }, "")
      : __dirname;

    // This API is not well made for Windows, ensure that the paths are UNIX slashes
    const fsMap = new Map<string, string>();
    const system = vfs.createFSBackedSystem(fsMap, projectDirname, ts);

    // TODO: investigate if we should create a PR in @typescript/vfs
    const oldReadFile = system.readFile.bind(system);
    system.readFile = (fileName) =>
      oldReadFile(fileName) ?? "// Non-existent file";

    const vfsPath = (inputPath: string) => {
      if (process.platform === "win32") return inputPath.replace(/\\/g, "/");
      return inputPath;
    };

    let compilerOptions: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      allowUnusedLabels: true,
    };

    // Find tsconfig.json file
    const tsconfigPath = ts.findConfigFile(
      projectDirname,
      ts.sys.fileExists,
      "tsconfig.json"
    );

    // Read tsconfig.json file
    if (tsconfigPath != null) {
      const tsconfigFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      const parsedTsconfig = ts.parseJsonConfigFileContent(
        tsconfigFile.config,
        ts.sys,
        path.dirname(tsconfigPath)
      );

      compilerOptions = {
        ...parsedTsconfig.options,
        ...compilerOptions,
        ...((options?.tsConfigOptions ?? {}) as ts.CompilerOptions),
      };
    }

    const vfsHost = vfs.createVirtualCompilerHost(system, compilerOptions, ts);
    const host = vfsHost.compilerHost;

    const targetPaths: { sourceFile: string; exportSymbol: string }[] = [];
    for (const item of target) {
      if (typeof item.sourceFile === "string") {
        targetPaths.push({ ...item, sourceFile: item.sourceFile });
      } else {
        for (const { path: sourcePath, contents, main } of item.sourceFile ??
          []) {
          fsMap.set(
            vfsPath(path.resolve(projectDirname, sourcePath)),
            contents
          );

          if (main) {
            targetPaths.push({
              ...item,
              sourceFile: path.resolve(projectDirname, sourcePath),
            });
          }
        }
      }
    }

    const moduleCache = ts.createModuleResolutionCache(
      projectDirname,
      (x) => x
    );
    host.resolveModuleNameLiterals = (
      entries,
      containingFile,
      redirectedReference,
      options
    ) =>
      entries.flatMap((entry) => {
        const specifier = entry.text;

        // Force module resolution to use @langchain/langgraph from the local project
        // rather than from API/CLI.
        let targetFile = containingFile;
        if (OVERRIDE_RESOLVE.some((regex) => regex.test(specifier))) {
          // check if we're not already importing from node_modules
          if (!containingFile.split(path.sep).includes("node_modules")) {
            // Doesn't matter if the file exists, only used to nudge `ts.resolveModuleName`
            targetFile = path.resolve(
              projectDirname,
              "__langgraph__resolve.mts"
            );
          }
        }

        return [
          ts.resolveModuleName(
            specifier,
            targetFile,
            options,
            host,
            moduleCache,
            redirectedReference
          ),
        ];
      });

    const research = ts.createProgram({
      rootNames: [INFER_TEMPLATE_PATH, ...targetPaths.map((i) => i.sourceFile)],
      options: compilerOptions,
      host,
    });

    const researchTargets: {
      rootName: string;
      exports: {
        typeName: string;
        valueName: string;
        graphName: string;
      }[];
    }[] = [];

    for (const targetPath of targetPaths) {
      const extractor = new SubgraphExtractor(
        research,
        research.getSourceFile(targetPath.sourceFile)!,
        research.getSourceFile(INFER_TEMPLATE_PATH)!,
        options
      );

      const graphDirname = path.dirname(targetPath.sourceFile);
      const { sourceFile, inferFile, exports } =
        extractor.getAugmentedSourceFile(
          path.relative(projectDirname, targetPath.sourceFile),
          targetPath.exportSymbol,
          {
            allowImportingTsExtensions:
              compilerOptions.allowImportingTsExtensions ?? false,
          }
        );

      for (const { fileName, contents } of [sourceFile, inferFile]) {
        system.writeFile(
          vfsPath(path.resolve(graphDirname, fileName)),
          contents
        );
      }

      researchTargets.push({
        rootName: path.resolve(graphDirname, inferFile.fileName),
        exports,
      });
    }

    const extract = ts.createProgram({
      rootNames: researchTargets.map((i) => i.rootName),
      options: compilerOptions,
      host,
    });

    // Print out any diagnostics file that were detected before emitting
    // This may explain why sometimes the schema is invalid.
    const allDiagnostics = ts.getPreEmitDiagnostics(extract);
    for (const diagnostic of allDiagnostics) {
      let message =
        `${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")  }\n`;

      if (diagnostic.file) {
        const {fileName} = diagnostic.file;
        const { line, character } = ts.getLineAndCharacterOfPosition(
          diagnostic.file,
          diagnostic.start!
        );
        const fileLoc = `(${line + 1},${character + 1})`;
        message = `${fileName} ${fileLoc}: ${message}`;
      }

      console.log(message);
    }

    const schemaGenerator = buildGenerator(extract);
    const trySymbol = (symbol: string) => {
      let schema: JSONSchema7 | undefined;
      try {
        schema = schemaGenerator?.getSchemaForSymbol(symbol) ?? undefined;
      } catch (e) {
        console.warn(
          `Failed to obtain symbol "${symbol}":`,
          (e as Error)?.message
        );
      }

      if (schema == null) return undefined;

      const {definitions} = schema;
      if (definitions == null) return schema;

      const toReplace = Object.keys(definitions).flatMap((key) => {
        const replacedKey = key.includes("import(")
          ? key.replace(/import\(.+@langchain[\\/]core.+\)\./, "")
          : key;

        if (key !== replacedKey && definitions[replacedKey] == null) {
          return [
            {
              source: key,
              target: replacedKey,

              sourceRef: `#/definitions/${key}`,
              targetRef: `#/definitions/${replacedKey}`,
            },
          ];
        }
        return [];
      });

      for (const { source, target } of toReplace) {
        definitions[target] = definitions[source];
        delete definitions[source];
      }

      const refMap = toReplace.reduce<Record<string, string>>((acc, item) => {
        acc[item.sourceRef] = item.targetRef;
        return acc;
      }, {});

      return JSON.parse(
        JSON.stringify(schema, (_, value) => {
          if (typeof value === "string" && refMap[value]) return refMap[value];
          return value;
        })
      );
    };

    return researchTargets.map(({ exports }) =>
      Object.fromEntries(
        exports.map(({ typeName, graphName }) => [
          graphName,
          {
            state: trySymbol(`${typeName}__update`),
            input: trySymbol(`${typeName}__input`),
            output: trySymbol(`${typeName}__output`),
            config: trySymbol(`${typeName}__config`),
          },
        ])
      )
    );
  }
}

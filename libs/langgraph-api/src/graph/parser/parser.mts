import * as ts from "typescript";
import * as vfs from "@typescript/vfs";
import * as path from "node:path";
import dedent from "dedent";
import { buildGenerator } from "./schema/types.mjs";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const OVERRIDE_RESOLVE = [
  // Override `@langchain/langgraph` or `@langchain/langgraph/prebuilt`,
  // but not `@langchain/langgraph-sdk`
  new RegExp(`^@langchain\/langgraph(\/.+)?$`),
  new RegExp(`^@langchain\/langgraph-checkpoint(\/.+)?$`),
];

const compilerOptions = {
  noEmit: true,
  strict: true,
  allowUnusedLabels: true,
};

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
    options?: { strict?: boolean },
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
    let result: ts.Type | undefined = undefined;

    const visit = (node: ts.Node) => {
      if (ts.isTypeAliasDeclaration(node)) {
        const symbol = (node as any).symbol;

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
    predicate: (node: ts.Node) => boolean,
  ): ts.Node | undefined => {
    let result: ts.Node | undefined = undefined;

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
    namespace: string[] = [],
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
      node: ts.Node,
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
                [],
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
              namespace: namespace,
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
        (node: any) => node && "flowNode" in node && node.flowNode,
      ) as InternalFlowNode | undefined;

      if (
        candidate?.flowNode &&
        this.isGraphOrPregelType(
          this.checker.getTypeAtLocation(candidate.flowNode.node),
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
          this.findSubgraphs(subgraph.node, [...namespace, node]),
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
      ts.isVariableDeclaration,
    );

    return varDecls.flatMap((varDecl) => {
      if (!varDecl.initializer) return [];
      return this.findSubgraphs(varDecl.initializer, [name]);
    });
  };

  public getAugmentedSourceFile = (
    name: string,
  ): {
    files: [filePath: string, contents: string][];
    exports: { typeName: string; valueName: string; graphName: string }[];
  } => {
    const vars = this.getSubgraphsVariables(name);
    type TypeExport = {
      typeName: `__langgraph__${string}`;
      valueName: string;
      graphName: string;
    };

    const typeExports: TypeExport[] = [
      { typeName: `__langgraph__${name}`, valueName: name, graphName: name },
    ];

    for (const { subgraph, node, namespace } of vars) {
      typeExports.push({
        typeName: `__langgraph__${namespace.join("_")}_${node}`,
        valueName: subgraph.name,
        graphName: [...namespace, node].join("|"),
      });
    }

    const sourceFilePath = "__langgraph__source.mts";
    const sourceContents = [
      this.getText(this.sourceFile),
      ...typeExports.map(
        ({ typeName, valueName }) =>
          `export type ${typeName} = typeof ${valueName}`,
      ),
    ].join("\n\n");

    const inferFilePath = "__langraph__infer.mts";
    const inferContents = [
      ...typeExports.map(
        ({ typeName }) =>
          `import type { ${typeName}} from "./__langgraph__source.mts"`,
      ),
      this.inferFile.getText(this.inferFile),

      ...typeExports.flatMap(({ typeName }) => {
        return [
          dedent`
            type ${typeName}__reflect = Reflect<${typeName}>;
            export type ${typeName}__state = Inspect<${typeName}__reflect["state"]>;
            export type ${typeName}__update = Inspect<${typeName}__reflect["update"]>;

            type ${typeName}__builder = BuilderReflect<${typeName}>;
            export type ${typeName}__input = Inspect<FilterAny<${typeName}__builder["input"]>>;
            export type ${typeName}__output = Inspect<FilterAny<${typeName}__builder["output"]>>;
            export type ${typeName}__config = Inspect<FilterAny<${typeName}__builder["config"]>>;
          `,
        ];
      }),
    ].join("\n\n");

    return {
      files: [
        [sourceFilePath, sourceContents],
        [inferFilePath, inferContents],
      ],
      exports: typeExports,
    };
  };

  protected findSubgraphIdentifiers = (
    acc: { node: ts.Node; name: string }[],
    node: ts.Node,
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
    initial: Acc,
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
    target:
      | string
      | {
          contents: string;
          files?: [fileName: string, contents: string][];
        },
    name: string,
    options?: { strict?: boolean },
  ) {
    const dirname =
      typeof target === "string" ? path.dirname(target) : __dirname;

    // This API is not well made for Windows, ensure that the paths are UNIX slashes
    const fsMap = new Map<string, string>();
    const system = vfs.createFSBackedSystem(fsMap, dirname, ts);

    // TODO: investigate if we should create a PR in @typescript/vfs
    const oldReadFile = system.readFile.bind(system);
    system.readFile = (fileName) =>
      oldReadFile(fileName) ?? "// Non-existent file";

    const vfsPath = (inputPath: string) => {
      if (process.platform === "win32") return inputPath.replace(/\\/g, "/");
      return inputPath;
    };

    const vfsHost = vfs.createVirtualCompilerHost(system, compilerOptions, ts);
    const host = vfsHost.compilerHost;

    const targetPath =
      typeof target === "string"
        ? target
        : path.resolve(dirname, "./__langgraph__target.mts");

    const inferTemplatePath = path.resolve(
      __dirname,
      "./schema/types.template.mts",
    );

    if (typeof target !== "string") {
      fsMap.set(vfsPath(targetPath), target.contents);
      for (const [name, contents] of target.files ?? []) {
        fsMap.set(vfsPath(path.resolve(dirname, name)), contents);
      }
    }

    const moduleCache = ts.createModuleResolutionCache(dirname, (x) => x);
    host.resolveModuleNameLiterals = (
      entries,
      containingFile,
      redirectedReference,
      options,
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
            targetFile = path.resolve(dirname, "__langgraph__resolve.mts");
          }
        }

        return [
          ts.resolveModuleName(
            specifier,
            targetFile,
            options,
            host,
            moduleCache,
            redirectedReference,
          ),
        ];
      });

    const research = ts.createProgram({
      rootNames: [inferTemplatePath, targetPath],
      options: compilerOptions,
      host,
    });

    const extractor = new SubgraphExtractor(
      research,
      research.getSourceFile(targetPath)!,
      research.getSourceFile(inferTemplatePath)!,
      options,
    );

    const { files, exports } = extractor.getAugmentedSourceFile(name);
    for (const [name, source] of files) {
      system.writeFile(vfsPath(path.resolve(dirname, name)), source);
    }

    const extract = ts.createProgram({
      rootNames: [path.resolve(dirname, "./__langraph__infer.mts")],
      options: compilerOptions,
      host,
    });

    const schemaGenerator = buildGenerator(extract);
    const trySymbol = (schema: typeof schemaGenerator, symbol: string) => {
      try {
        return schema?.getSchemaForSymbol(symbol) ?? undefined;
      } catch (e) {
        console.warn(
          `Failed to obtain symbol "${symbol}":`,
          (e as Error)?.message,
        );
      }
      return undefined;
    };

    return Object.fromEntries(
      exports.map(({ typeName, graphName }) => [
        graphName,
        {
          input: trySymbol(schemaGenerator, `${typeName}__input`),
          output: trySymbol(schemaGenerator, `${typeName}__output`),
          state: trySymbol(schemaGenerator, `${typeName}__update`),
          config: trySymbol(schemaGenerator, `${typeName}__config`),
        },
      ]),
    );
  }
}

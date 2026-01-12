import { getBuildConfig, cjsCompatPlugin } from "@langchain/build";

export default getBuildConfig({
  entry: [
    "./src/index.ts",
    "./src/web.ts",
    "./src/channels/index.ts",
    "./src/pregel/index.ts",
    "./src/prebuilt/index.ts",
    "./src/remote.ts",
    "./src/graph/zod/index.ts",
    "./src/graph/zod/schema.ts",
  ],
  plugins: [
    cjsCompatPlugin({
      files: ["dist/", "CHANGELOG.md", "LICENSE"],
    }),
  ],
  unused: {
    level: "error",
    // These are peerDependencies required by the re-exported @langchain/langgraph,
    // not directly imported by this wrapper package
    ignore: ["@langchain/core", "zod"],
  },
});

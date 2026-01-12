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
      files: ["dist/", "CHANGELOG.md", "README.md", "LICENSE"],
    }),
  ],
});

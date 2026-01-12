import { getBuildConfig, cjsCompatPlugin } from "@langchain/build";

export default getBuildConfig({
  entry: ["./src/index.ts", "./src/shallow.ts", "./src/store.ts"],
  plugins: [
    cjsCompatPlugin({
      files: ["dist/"],
    }),
  ],
});

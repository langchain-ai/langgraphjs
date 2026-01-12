import { getBuildConfig, cjsCompatPlugin } from "@langchain/build";

export default getBuildConfig({
  entry: ["./src/index.ts", "./src/cli.ts"],
  plugins: [
    cjsCompatPlugin({
      files: ["dist/", "bin/"],
    }),
  ],
});

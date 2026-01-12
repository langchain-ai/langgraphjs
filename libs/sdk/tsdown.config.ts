import { getBuildConfig, cjsCompatPlugin } from "@langchain/build";

export default getBuildConfig({
  entry: [
    "./src/index.ts",
    "./src/client.ts",
    "./src/auth/index.ts",
    "./src/react/index.ts",
    "./src/logging/index.ts",
    "./src/react-ui/index.ts",
    "./src/react-ui/server/index.ts",
  ],
  plugins: [
    cjsCompatPlugin({
      files: ["dist/"],
    }),
  ],
});

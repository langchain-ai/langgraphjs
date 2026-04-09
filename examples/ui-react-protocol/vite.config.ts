import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@langchain/react": fileURLToPath(
        new URL("../../libs/sdk-react/dist/index.js", import.meta.url)
      ),
    },
  },
});

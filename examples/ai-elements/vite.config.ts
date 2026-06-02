import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig(() => {
  return {
    base: process.env.DEPLOY_BASE || "/",
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        src: path.resolve(import.meta.dirname, "./src"),
      },
    },
    clearScreen: false
  };
});

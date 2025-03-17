import { configDefaults, defineConfig } from 'vitest/config'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  test: {
    exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
    browser: {
      provider: 'playwright', // or 'webdriverio'
      enabled: true,
      // at least one instance is required
      instances: [
        { browser: 'chromium' },
      ],
    },
  },
  plugins: [nodePolyfills()],
})
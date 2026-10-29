import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // AI SDK packages ship ESM only and are dev dependencies, so they are bundled into the CommonJS main process.
      externalizeDeps: { exclude: ['ai', '@ai-sdk/openai', '@ai-sdk/typesafe-ai', 'ai-sdk-provider-codex-cli', 'zod'] },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
})

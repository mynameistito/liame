import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // These ship ESM only; bundle them into the CommonJS main process instead of requiring them.
      externalizeDeps: { exclude: ['ai', '@ai-sdk/openai', '@ai-sdk/typesafe-ai', 'ai-sdk-provider-codex-cli'] },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
})

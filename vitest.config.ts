import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    testTimeout: 30_000,
    server: {
      deps: {
        inline: [
          '@deepseek-ai/dsh-client-ui-attachment',
          '@deepseek-ai/dsh-client-ui-primitives',
        ],
      },
    },
  },
})

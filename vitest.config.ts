import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    testTimeout: 30_000,
    server: {
      deps: {
        inline: [
          '@monotykamary/dsh-client-ui-attachment',
          '@monotykamary/dsh-client-ui-primitives',
        ],
      },
    },
  },
})

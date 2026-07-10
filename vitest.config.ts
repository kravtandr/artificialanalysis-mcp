import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/api/types.gen.ts'],
      thresholds: {
        'src/match.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/api/client.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});

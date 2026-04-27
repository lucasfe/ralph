import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js', 'src/**/*.test.js', 'lib/**/*.test.js'],
    passWithNoTests: true,
  },
})

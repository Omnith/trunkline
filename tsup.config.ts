import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { agentphone: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node22',
  splitting: true,
  clean: true,
  sourcemap: true,
})

import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['../tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    include: ['src/**/*.spec.ts'],
    pool: 'forks',
    execArgv: vitestExecArgv,
  },
})
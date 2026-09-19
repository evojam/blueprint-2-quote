// Flat ESLint config for a standalone Open Mercato app.
// `next lint` was removed in Next 16, so `yarn lint` runs the ESLint CLI
// against this config instead.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

const ignores = [
  'node_modules/**',
  '.next/**',
  // Agent tooling, not app source. `.claude/worktrees/` holds FULL checkouts of this
  // repository, so without this every file in every worktree is linted twice — once
  // here and once in its own checkout — and a lint run turns red on code that is not
  // in this working tree at all.
  '.claude/**',
  '.mercato/**',
  '.ai/framework-context/**',
  'dist/**',
  'out/**',
  'build/**',
  'next-env.d.ts',
]

const ruleOverrides = {
  'react/display-name': 'off',
  'react-hooks/immutability': 'off',
  'react-hooks/preserve-manual-memoization': 'off',
  'react-hooks/purity': 'off',
  'react-hooks/refs': 'off',
  'react-hooks/set-state-in-effect': 'off',
  'react-hooks/static-components': 'off',
}

export default [
  ...nextCoreWebVitals,
  { ignores },
  { name: 'app/rule-overrides', rules: ruleOverrides },
]

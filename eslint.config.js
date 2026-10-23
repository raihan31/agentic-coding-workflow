import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'runs/', 'web/dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Plain JS modules run under Node (TypeScript files get globals from @types/node).
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly' } } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }] } },
);

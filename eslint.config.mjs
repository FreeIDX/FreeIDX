import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import i18nPlugin from './scripts/eslint-plugin-i18n.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      'packages/shared/src/i18n/gen/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { i18n: i18nPlugin, 'react-hooks': reactHooks },
    rules: {
      'i18n/no-hardcoded-zh': 'error',
      /* React Hooks 规则：此前全仓未接入，依赖漂移只能靠人工评审发现 */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);

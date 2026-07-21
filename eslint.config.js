import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
      },
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // tsc already checks undefined globals/types with full type
      // information (ambient types like NodeJS.ProcessEnv); no-undef
      // duplicates that poorly without type awareness and false-positives
      // on ambient globals.
      'no-undef': 'off',
    },
  },
  prettierConfig,
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.js'],
  },
];

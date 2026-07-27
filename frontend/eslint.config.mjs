import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['**/*.js'],
    ignores: ['vendor/**', 'node_modules/**', 'test/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
        argon2: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
      'no-console': 'off',
    },
  },
];

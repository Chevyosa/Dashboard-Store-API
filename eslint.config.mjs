import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    // domain/ must stay pure: no I/O, no framework, no clock, no random (AGENTS.md §4)
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'mysql2',
                'mysql2/*',
                'express',
                'fs',
                'fs/*',
                'node:fs',
                'node:fs/*',
                'node:crypto',
                'crypto',
                'node:net',
                'node:http',
                'node:child_process',
              ],
              message: 'domain/ harus murni: tanpa I/O, framework, atau random.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'domain/ tidak boleh memakai jam sistem.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'domain/ tidak boleh memakai random.' },
        {
          object: 'Math',
          property: 'round',
          message: 'Dilarang membulatkan angka bisnis (BR-02).',
        },
        {
          object: 'Math',
          property: 'floor',
          message: 'Dilarang membulatkan angka bisnis (BR-02).',
        },
        { object: 'Math', property: 'ceil', message: 'Dilarang membulatkan angka bisnis (BR-02).' },
        { object: 'Date', property: 'now', message: 'domain/ tidak boleh memakai jam sistem.' },
      ],
    },
  },
  prettier,
);

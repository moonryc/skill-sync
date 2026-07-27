import eslint from '@eslint/js';
import eslintPluginAstro from 'eslint-plugin-astro';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '**/.astro/**', '.skill-sync/**'],
  },
  eslint.configs.recommended,
  ...eslintPluginAstro.configs['flat/recommended'],
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['apps/wiki/**/*.astro'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.astro'],
      },
    },
  },
  {
    files: ['apps/wiki/**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    files: ['*.js', 'apps/wiki/**/*.mjs', 'libs/*/scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

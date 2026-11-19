import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['build/**', '.react-router/**', '.wrangler/**', 'playwright-report/**', 'test-results/**', 'coverage/**'] },
  js.configs.recommended,
  // The same rule and limit as SonarQube S3776, on the SonarQube sources only.
  {
    files: ['app/**', 'worker/**', 'db/**'],
    plugins: { sonarjs },
    rules: { 'sonarjs/cognitive-complexity': ['error', 15] },
  },
  ...tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/only-throw-error': ['error', { allow: [{ from: 'lib', name: 'Response' }] }] } },
);

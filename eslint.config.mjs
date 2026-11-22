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
  // The same rules as SonarQube S6582, S6594 and S7781, on the SonarQube sources only. The SonarQube gate runs
  // only on main, after the merge. A finding there stops the deploy.
  {
    files: ['app/**', 'worker/**', 'db/**'],
    plugins: { sonarjs },
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'error',
      'sonarjs/prefer-regexp-exec': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='replace'][arguments.0.regex.flags=/g/]",
          message: "Prefer 'String#replaceAll()' over 'String#replace()' with a global pattern (SonarQube S7781).",
        },
      ],
    },
  },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/only-throw-error': ['error', { allow: [{ from: 'lib', name: 'Response' }] }] } },
);

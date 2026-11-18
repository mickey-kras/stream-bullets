import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();

for (const filePath of ['app/root.tsx', 'scripts/browser-coverage.ts']) {
  void test(`typed lint rejects unhandled promises in ${filePath}`, async () => {
    const results = await eslint.lintText('Promise.resolve(1);\n', { filePath });
    assert.ok(results[0]?.messages.some((message) => message.ruleId === '@typescript-eslint/no-floating-promises' && message.severity === 2));
  });
}

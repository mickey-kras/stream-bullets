import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "esbuild";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applicationSourcePath,
  coverageReport,
  validateBrowserCoverage,
} from "./browser-coverage.ts";

import { mergeBrowserCoverage } from "./merge-browser-coverage.ts";

describe("browser coverage", (): void => {
  it("normalizes source-map paths to the repository", (): void => {
    assert.equal(
      applicationSourcePath("../../app/routes/home.tsx"),
      "app/routes/home.tsx",
    );
    assert.equal(
      applicationSourcePath("C:\\repo\\app\\root.tsx"),
      "app/root.tsx",
    );
    assert.equal(applicationSourcePath("app/root.tsx"), "app/root.tsx");
  });

  it("rejects empty reports and mixed mapped and unmapped paths", (): void => {
    assert.throws(
      () => validateBrowserCoverage(""),
      /only mapped application sources/,
    );
    assert.throws(
      () =>
        validateBrowserCoverage(
          "SF:app/root.tsx\nSF:localhost-5173/assets/en.js\n",
        ),
      /only mapped application sources/,
    );
    assert.doesNotThrow(() =>
      validateBrowserCoverage("SF:app/root.tsx\nSF:app/routes/home.tsx\n"),
    );
  });

  it("merges browser entries and maps executed code back to TypeScript", async (): Promise<void> => {
    const directory: string = await mkdtemp(
      join(tmpdir(), "browser-coverage-"),
    );
    try {
      const source: string = "export const value: number = 42;\n";
      const { code } = await transform(source, {
        loader: "ts",
        format: "esm",
        sourcemap: "inline",
        sourcefile: "../../app/coverage-example.ts",
      });
      const entry = {
        url: "http://localhost:5173/assets/example.js",
        scriptId: "1",
        source: code,
        functions: [
          {
            functionName: "",
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }],
          },
        ],
      };
      // Separate report instances mirror the Playwright worker and reporter processes.
      await coverageReport(directory).add([entry]);
      await coverageReport(directory).add([
        { ...entry, url: "https://third-party.example/script.js" },
      ]);
      // Vite emits JSON catalogs as JavaScript without a source map.
      await coverageReport(directory).add([
        {
          ...entry,
          url: "http://localhost:5173/assets/en-catalog.js",
          source: "const messages = {};",
        },
      ]);
      await coverageReport(directory).generate();
      const lcov: string = await readFile(join(directory, "lcov.info"), "utf8");
      assert.ok(lcov.includes("SF:app/coverage-example.ts"));
      assert.ok(lcov.includes("DA:1,1"));
      assert.ok(!lcov.includes("third-party"));
      assert.ok(!lcov.includes("localhost-5173"));
      validateBrowserCoverage(lcov);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("combines disjoint shards and rejects missing or empty inputs", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "browser-shards-"));
    const shards: string[] = [join(directory, "one"), join(directory, "two")];
    try {
      for (const [index, shard] of shards.entries()) {
        await mkdir(shard);
        const { code } = await transform("export const value: number = 42;\n", {
          loader: "ts",
          format: "esm",
          sourcemap: "inline",
          sourcefile: `../../app/shard-${index}.ts`,
        });
        await writeFile(
          join(shard, "raw.json"),
          JSON.stringify([
            {
              url: `http://localhost:5173/assets/shard-${index}.js`,
              scriptId: "1",
              source: code,
              functions: [
                {
                  functionName: "",
                  isBlockCoverage: true,
                  ranges: [
                    { startOffset: 0, endOffset: code.length, count: 1 },
                  ],
                },
              ],
            },
          ]),
        );
      }
      const output: string = join(directory, "merged");
      await mergeBrowserCoverage(shards, output);
      const lcov: string = await readFile(join(output, "lcov.info"), "utf8");
      assert.ok(lcov.includes("SF:app/shard-0.ts"));
      assert.ok(lcov.includes("SF:app/shard-1.ts"));
      await assert.rejects(
        mergeBrowserCoverage([], output),
        /inputs are required/,
      );
      await assert.rejects(
        mergeBrowserCoverage([join(directory, "missing")], output),
        /ENOENT/,
      );
      await writeFile(join(shards[1], "empty-page.json"), "[]");
      await mergeBrowserCoverage(shards, output);
      await writeFile(join(shards[1], "raw.json"), "[]");
      await assert.rejects(
        mergeBrowserCoverage(shards, output),
        /Missing browser coverage/,
      );
      await rm(join(shards[1], "empty-page.json"));
      await rm(join(shards[1], "raw.json"));
      await assert.rejects(
        mergeBrowserCoverage(shards, output),
        /Missing browser coverage/,
      );
      await writeFile(join(shards[1], "raw.json"), "{}");
      await assert.rejects(mergeBrowserCoverage(shards, output));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

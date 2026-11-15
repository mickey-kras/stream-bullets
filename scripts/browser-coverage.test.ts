import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Context, createContext, Script } from "node:vm";
import { transform } from "esbuild";
import {
  applicationAsset,
  productSource,
  requireProductCoverage,
  validateBrowserCoverage,
} from "./browser-coverage.ts";
import { mergeBrowserCoverage } from "./merge-browser-coverage.ts";
import {
  mergeUiSnapshot,
  resetUiCounters,
  snapshotUiCounters,
  UI_COVERAGE_PREFIX,
  type UiCoverage,
  type UiInventory,
  type UiSnapshot,
  uiInventorySchema,
  validateUiInventory,
} from "./ui-coverage.ts";
import { type InstrumentedUi, instrumentUiSource } from "./ui-coverage-plugin.ts";

const path: string = "app/example.tsx";
const source: string = `export function choose(value: number) {
  if (value > 0) { return <b>{value}</b>; }
  else if (value < 0) { return <i>{value}</i>; }
  return value === 0 ? <span>zero</span> : null;
}
export const untouched = () => <em>never</em>;
export const nested = (callback = () => false) => callback() && true;
export class Example { value = () => false; }
`;

async function execution(instrumented: InstrumentedUi, argument: number, minify: boolean): Promise<UiSnapshot> {
  const context: Context = createContext({ module: { exports: {} }, jsx: (): object => ({}) });
  const { code } = await transform(instrumented.code, {
    loader: "tsx",
    format: "cjs",
    minify,
    jsxFactory: "jsx",
    sourcefile: path,
  });
  new Script(code).runInContext(context);
  new Script(`module.exports.choose(${argument})`).runInContext(context);
  const native: unknown = Reflect.get(context, `${UI_COVERAGE_PREFIX}${instrumented.sourceHash}`);
  const files = Object.fromEntries(
    Object.entries(native as Record<string, UiCoverage>).map(([name, coverage]) => [
      name,
      { sourceHash: instrumented.sourceHash, coverage: structuredClone(coverage) },
    ]),
  );
  // Parse after crossing the VM realm so prototypes do not affect metadata identity.
  return JSON.parse(JSON.stringify({ version: 1, id: `execution:${argument}:${minify}`, files })) as UiSnapshot;
}
function baseline(instrumented: InstrumentedUi): UiInventory {
  return uiInventorySchema.parse(
    JSON.parse(
      JSON.stringify({
        version: 1,
        files: { [path]: { sourceHash: instrumented.sourceHash, coverage: instrumented.coverage } },
      }),
    ),
  );
}
function result(inventory: UiInventory): Record<string, UiCoverage> {
  return Object.fromEntries(
    Object.entries(inventory.files).map(([name, file]) => [name, structuredClone(file.coverage)]),
  );
}

describe("original-source UI coverage", (): void => {
  it("uses identical original TSX maps across unit and minified browser transforms, retains untouched nodes and opposite branches", async (): Promise<void> => {
    const instrumented: InstrumentedUi = instrumentUiSource(path, source);
    assert.ok(instrumented.code.includes("globalThis"));
    assert.ok(!instrumented.code.includes("new Function"));
    const inventory: UiInventory = baseline(instrumented);
    const unit: UiSnapshot = await execution(instrumented, 1, false);
    const browser: UiSnapshot = await execution(instrumented, -1, true);
    const combined: Record<string, UiCoverage> = result(inventory);
    mergeUiSnapshot(combined, inventory, unit);
    mergeUiSnapshot(combined, inventory, browser);
    assert.deepEqual(combined[path].statementMap, inventory.files[path].coverage.statementMap);
    assert.deepEqual(combined[path].fnMap, inventory.files[path].coverage.fnMap);
    assert.deepEqual(combined[path].branchMap, inventory.files[path].coverage.branchMap);
    assert.equal(Object.values(combined[path].f).filter((count: number): boolean => count > 0).length, 1);
    assert.ok(
      Object.values(combined[path].b).some((arms: number[]): boolean =>
        arms.every((count: number): boolean => count > 0),
      ),
    );
    assert.ok(Object.values(combined[path].s).some((count: number): boolean => count === 0));
  });

  it("rejects changed source hashes, full maps, counter keys, and branch arity", async (): Promise<void> => {
    const instrumented: InstrumentedUi = instrumentUiSource(path, source);
    const inventory: UiInventory = baseline(instrumented);
    const snapshot: UiSnapshot = await execution(instrumented, 1, false);
    const changed: UiSnapshot = structuredClone(snapshot);
    changed.files[path].sourceHash = "0".repeat(64);
    assert.throws(() => mergeUiSnapshot(result(inventory), inventory, changed), /changed UI coverage source/);
    changed.files[path].sourceHash = instrumented.sourceHash;
    changed.files[path].coverage.statementMap["0"] = {};
    assert.throws(() => mergeUiSnapshot(result(inventory), inventory, changed), /maps differ/);
    const keys: UiSnapshot = structuredClone(snapshot);
    keys.files[path].coverage.f.extra = 0;
    assert.throws(() => mergeUiSnapshot(result(inventory), inventory, keys), /counter inventory/);
    const branches: UiSnapshot = structuredClone(snapshot);
    branches.files[path].coverage.b["0"].push(1);
    assert.throws(() => mergeUiSnapshot(result(inventory), inventory, branches), /branch arity/);
  });

  it("resets cached native counter objects in place between delta snapshots", (): void => {
    const instrumented: InstrumentedUi = instrumentUiSource(
      "app/counter.ts",
      "function hit() { return 1; } globalThis.uiHit = hit;",
    );
    new Script(instrumented.code).runInThisContext();
    const hit: () => number = Reflect.get(globalThis, "uiHit") as () => number;
    try {
      hit();
      const first: UiSnapshot = snapshotUiCounters("first");
      resetUiCounters();
      hit();
      const second: UiSnapshot = snapshotUiCounters("second");
      assert.equal(first.files["app/counter.ts"].coverage.f["0"], 1);
      assert.equal(second.files["app/counter.ts"].coverage.f["0"], 1);
      const duplicate: string = `${UI_COVERAGE_PREFIX}${"0".repeat(64)}`;
      Reflect.set(globalThis, duplicate, { "app/counter.ts": instrumented.coverage });
      try {
        assert.throws(() => snapshotUiCounters("duplicate"), /multiple versions of one source/);
      } finally {
        Reflect.deleteProperty(globalThis, duplicate);
      }
    } finally {
      Reflect.deleteProperty(globalThis, "uiHit");
      Reflect.deleteProperty(globalThis, `${UI_COVERAGE_PREFIX}${instrumented.sourceHash}`);
    }
  });

  it("requires complete current inventory and preserves unvisited route zeros through reporting", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "ui-coverage-"));
    const previous: string = process.cwd();
    try {
      await mkdir(join(directory, "app/routes"), { recursive: true });
      await writeFile(join(directory, path), source);
      const unvisitedPath: string = "app/routes/unvisited.tsx";
      const unvisitedSource: string = "export const neverCalled = () => <p>never visited</p>;\n";
      await writeFile(join(directory, unvisitedPath), unvisitedSource);
      const instrumented: InstrumentedUi = instrumentUiSource(path, source);
      const inventory: UiInventory = baseline(instrumented);
      assert.throws(() => validateUiInventory(inventory, directory), /every product source/);
      const unvisited: InstrumentedUi = instrumentUiSource(unvisitedPath, unvisitedSource);
      inventory.files[unvisitedPath] = uiInventorySchema.parse({
        version: 1,
        files: { [unvisitedPath]: { sourceHash: unvisited.sourceHash, coverage: unvisited.coverage } },
      }).files[unvisitedPath];
      validateUiInventory(inventory, directory);
      for (const name of ["browser", "unit"]) {
        await mkdir(join(directory, name, "raw"), { recursive: true });
        await writeFile(join(directory, name, "inventory.json"), JSON.stringify(inventory));
      }
      const snapshot: UiSnapshot = await execution(instrumented, 1, false);
      await writeFile(join(directory, "browser/raw/page.json"), JSON.stringify(snapshot));
      await writeFile(join(directory, "unit/raw/unit.json"), JSON.stringify({ version: 1, id: "unit", files: {} }));
      process.chdir(directory);
      await assert.rejects(mergeBrowserCoverage([], "out"), /inputs are required/);
      await assert.rejects(mergeBrowserCoverage(["browser"], "out", "unit"), /below 90%/);
      const report: string = await readFile("out/product/lcov.info", "utf8");
      assert.ok(report.includes(`SF:${unvisitedPath}`));
      assert.match(report, /FNDA:0,/);
      await writeFile("unit/raw/unit.json", JSON.stringify(snapshot));
      await assert.rejects(mergeBrowserCoverage(["browser"], "out", "unit"), /Duplicate UI coverage snapshot/);
      await writeFile("app/example.tsx", source.replace("zero", "ZERO"));
      await assert.rejects(mergeBrowserCoverage(["browser"], "out"), /inventory source differs/);
    } finally {
      process.chdir(previous);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("coverage boundaries and gates", (): void => {
  it("keeps provider assets and separately gated production sources outside the UI inventory", (): void => {
    assert.ok(applicationAsset("https://localhost:5174/assets/sign-in.js"));
    assert.ok(!applicationAsset("https://accounts.google.com/assets/sign-in.js"));
    assert.ok(!applicationAsset("https://localhost:51740/assets/sign-in.js"));
    assert.ok(productSource("app/components/account/data-dialog.tsx"));
    for (const excluded of [
      "app/components/station/scene.tsx",
      "app/server/api.ts",
      "app/lib/validators.ts",
      "app/routes.ts",
      "app/entry.server.tsx",
      "app/types.d.ts",
    ])
      assert.ok(!productSource(excluded));
    assert.throws(() => validateBrowserCoverage(""), /only mapped application sources/);
    assert.throws(
      () => validateBrowserCoverage("SF:app/root.tsx\nSF:localhost/assets/en.js\n"),
      /only mapped application sources/,
    );
  });
  it("enforces every metric without rounding a shortfall up to 90%", (): void => {
    const passing = { covered: 90, total: 100, pct: 90, status: "high" as const };
    const summary = { lines: passing, statements: passing, functions: passing, branches: passing };
    assert.doesNotThrow(() => requireProductCoverage(summary));
    for (const metric of ["lines", "statements", "functions", "branches"] as const)
      assert.throws(
        () => requireProductCoverage({ ...summary, [metric]: { ...passing, covered: 89999, total: 100000 } }),
        /below 90%/,
      );
    assert.throws(
      () => requireProductCoverage({ ...summary, lines: { ...passing, covered: 0, total: 0 } }),
      /coverage is missing/,
    );
  });
});

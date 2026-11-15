import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInstrumenter, type Instrumenter } from "istanbul-lib-instrument";
import type { Plugin, ResolvedConfig } from "vite";
import { productSource } from "./browser-coverage.ts";
import { UI_COVERAGE_PREFIX, type UiInventory, uiSourceHash, uiSourcePaths } from "./ui-coverage.ts";

type SourceMap = Omit<ReturnType<Instrumenter["lastSourceMap"]>, "version"> & { version: 3 };
export interface InstrumentedUi {
  code: string;
  map: SourceMap;
  sourceHash: string;
  coverage: ReturnType<Instrumenter["lastFileCoverage"]>;
}

export function instrumentUiSource(path: string, source: string): InstrumentedUi {
  const sourceHash: string = uiSourceHash(path, source);
  const instrumenter: Instrumenter = createInstrumenter({
    coverageVariable: `${UI_COVERAGE_PREFIX}${sourceHash}`,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    produceSourceMap: true,
    preserveComments: true,
    parserPlugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
  });
  const code: string = instrumenter.instrumentSync(source, path);
  return {
    code,
    map: { ...instrumenter.lastSourceMap(), version: 3 },
    sourceHash,
    coverage: instrumenter.lastFileCoverage(),
  };
}

// Loading raw files precedes every transform, including React Router's export removal and Vite's TS/JSX compilation.
export function uiCoveragePlugin(mode: "unit" | "browser"): Plugin {
  let root: string = "";
  const cache: Map<string, InstrumentedUi> = new Map();
  return {
    name: "streambullets-ui-coverage",
    enforce: "pre",
    applyToEnvironment: (environment): boolean => mode === "unit" || environment.name === "client",
    configResolved(config: ResolvedConfig): void {
      root = config.root;
      const inventory: UiInventory = { version: 1, files: {} };
      for (const path of uiSourcePaths(root)) {
        const instrumented: InstrumentedUi = instrumentUiSource(path, readFileSync(join(root, path), "utf8"));
        cache.set(path, instrumented);
        inventory.files[path] = { sourceHash: instrumented.sourceHash, coverage: instrumented.coverage };
      }
      const directory: string = join(root, mode === "unit" ? ".react-router/ui-coverage" : "coverage/browser");
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "inventory.json.tmp"), JSON.stringify(inventory));
      renameSync(join(directory, "inventory.json.tmp"), join(directory, "inventory.json"));
    },
    load(id: string) {
      // Query modules belong to Vite/React Router. Their plain source modules load through this hook.
      if (id.includes("?") || id.startsWith("\0")) return null;
      const path: string = relative(root, resolve(id)).replaceAll("\\", "/");
      if (!productSource(path)) return null;
      const instrumented: InstrumentedUi | undefined = cache.get(path);
      if (!instrumented) throw new Error(`UI coverage source is absent from inventory: ${path}`);
      if (instrumented.sourceHash !== uiSourceHash(path, readFileSync(id, "utf8")))
        throw new Error(`UI coverage source changed during the run: ${path}`);
      return { code: instrumented.code, map: instrumented.map };
    },
  };
}

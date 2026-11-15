import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { CoverageReport } from "monocart-coverage-reports";
import { requireProductCoverage, validateBrowserCoverage } from "./browser-coverage.ts";
import {
  mergeUiSnapshot,
  type UiCoverage,
  type UiInventory,
  type UiSnapshot,
  uiInventorySchema,
  uiSnapshotSchema,
  validateUiInventory,
} from "./ui-coverage.ts";

export async function mergeBrowserCoverage(
  directories: string[],
  outputDir: string = "coverage/browser",
  unitDirectory?: string,
): Promise<void> {
  if (directories.length === 0) throw new Error("Browser coverage inputs are required.");
  let inventory: UiInventory | undefined;
  const result: Record<string, UiCoverage> = {};
  const ids: Set<string> = new Set();
  for (const directory of [...directories, ...(unitDirectory ? [unitDirectory] : [])]) {
    const current: UiInventory = uiInventorySchema.parse(
      JSON.parse(await readFile(join(directory, "inventory.json"), "utf8")),
    );
    validateUiInventory(current, process.cwd());
    if (inventory && !isDeepStrictEqual(inventory, current))
      throw new Error(`UI coverage inventories differ: ${directory}`);
    if (!inventory) {
      inventory = current;
      for (const [path, file] of Object.entries(inventory.files)) result[path] = structuredClone(file.coverage);
    }
    const files: string[] = (await readdir(join(directory, "raw"))).filter((file: string): boolean =>
      file.endsWith(".json"),
    );
    if (files.length === 0) throw new Error(`Missing UI coverage snapshots: ${directory}`);
    for (const file of files) {
      const snapshot: UiSnapshot = uiSnapshotSchema.parse(
        JSON.parse(await readFile(join(directory, "raw", file), "utf8")),
      );
      if (ids.has(snapshot.id)) throw new Error(`Duplicate UI coverage snapshot: ${snapshot.id}`);
      ids.add(snapshot.id);
      mergeUiSnapshot(result, inventory, snapshot);
    }
  }
  // Feed one complete, identically instrumented map to the reporter: no cross-transform map merging.
  for (const directory of unitDirectory ? [outputDir, join(outputDir, "product")] : [outputDir]) {
    const coverage = new CoverageReport({
      outputDir: directory,
      reports: ["lcovonly", "json", "console-summary"],
      ...(directory === join(outputDir, "product")
        ? {
            onEnd: (results): void => {
              if (!results) throw new Error("Product UI coverage is missing.");
              requireProductCoverage(results.summary);
            },
          }
        : {}),
    });
    await coverage.add(result);
    await coverage.generate();
    validateBrowserCoverage(await readFile(join(directory, "lcov.info"), "utf8"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mergeBrowserCoverage(process.argv.slice(2), "coverage/browser", "coverage/ui-unit");
}

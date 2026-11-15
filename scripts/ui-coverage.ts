import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { productSource } from "./browser-coverage.ts";

export const UI_COVERAGE_PREFIX: string = "__streambullets_ui_";
const counts = z.record(z.string(), z.number().int().nonnegative());
const coverageSchema = z.object({
  path: z.string(),
  statementMap: z.record(z.string(), z.unknown()),
  fnMap: z.record(z.string(), z.unknown()),
  branchMap: z.record(z.string(), z.unknown()),
  s: counts,
  f: counts,
  b: z.record(z.string(), z.array(z.number().int().nonnegative())),
});
export const uiInventorySchema = z.object({
  version: z.literal(1),
  files: z.record(
    z.string(),
    z.object({
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      coverage: coverageSchema,
    }),
  ),
});
export const uiSnapshotSchema = uiInventorySchema.extend({ id: z.string().min(1).max(200) });
export type UiInventory = z.infer<typeof uiInventorySchema>;
export type UiSnapshot = z.infer<typeof uiSnapshotSchema>;
export type UiCoverage = UiInventory["files"][string]["coverage"];

export function uiSourcePaths(root: string): string[] {
  return readdirSync(join(root, "app"), { recursive: true, withFileTypes: true })
    .filter((entry): boolean => entry.isFile())
    .map((entry): string => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .filter(productSource)
    .sort();
}

export function uiSourceHash(path: string, source: string): string {
  return createHash("sha256").update(`${path}\0${source}`).digest("hex");
}

export function validateUiInventory(inventory: UiInventory, root: string): void {
  if (!isDeepStrictEqual(Object.keys(inventory.files).sort(), uiSourcePaths(root)))
    throw new Error("UI coverage inventory does not contain every product source.");
  for (const [path, file] of Object.entries(inventory.files)) {
    if (file.coverage.path !== path || file.sourceHash !== uiSourceHash(path, readFileSync(join(root, path), "utf8")))
      throw new Error(`UI coverage inventory source differs: ${path}`);
    if (
      [
        ...Object.values(file.coverage.s),
        ...Object.values(file.coverage.f),
        ...Object.values(file.coverage.b).flat(),
      ].some((count: number): boolean => count !== 0)
    )
      throw new Error(`UI coverage inventory must start with zero counters: ${path}`);
  }
}

// Keep counter objects alive: instrumented modules cache references to these objects.
export function resetUiCounters(): void {
  for (const key of Object.keys(globalThis).filter((name: string): boolean => name.startsWith(UI_COVERAGE_PREFIX))) {
    const table: Record<string, UiCoverage> = Reflect.get(globalThis, key) as Record<string, UiCoverage>;
    for (const file of Object.values(table)) {
      for (const id of Object.keys(file.s)) file.s[id] = 0;
      for (const id of Object.keys(file.f)) file.f[id] = 0;
      for (const id of Object.keys(file.b)) file.b[id].fill(0);
    }
  }
}

export function snapshotUiCounters(id: string): UiSnapshot {
  const files: UiInventory["files"] = {};
  for (const key of Object.keys(globalThis).filter((name: string): boolean => name.startsWith(UI_COVERAGE_PREFIX))) {
    const table: Record<string, UiCoverage> = Reflect.get(globalThis, key) as Record<string, UiCoverage>;
    for (const [path, coverage] of Object.entries(table)) {
      if (files[path]) throw new Error(`UI coverage contains multiple versions of one source: ${path}`);
      files[path] = {
        sourceHash: key.slice(UI_COVERAGE_PREFIX.length),
        coverage: structuredClone(coverage),
      };
    }
  }
  return uiSnapshotSchema.parse({ version: 1, id, files });
}

export async function writeUiSnapshot(directory: string, snapshot: UiSnapshot): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target: string = join(directory, `${randomUUID()}.json`);
  await writeFile(`${target}.tmp`, JSON.stringify(uiSnapshotSchema.parse(snapshot)));
  await rename(`${target}.tmp`, target);
}

export function mergeUiSnapshot(
  result: Record<string, UiCoverage>,
  inventory: UiInventory,
  snapshot: UiSnapshot,
): void {
  for (const [path, observed] of Object.entries(snapshot.files)) {
    const expected = inventory.files[path];
    if (!expected || observed.sourceHash !== expected.sourceHash || observed.coverage.path !== path)
      throw new Error(`Unknown or changed UI coverage source: ${path}`);
    for (const field of ["statementMap", "fnMap", "branchMap"] as const)
      if (!isDeepStrictEqual(observed.coverage[field], expected.coverage[field]))
        throw new Error(`UI coverage maps differ: ${path}`);
    for (const field of ["s", "f", "b"] as const)
      if (
        !isDeepStrictEqual(Object.keys(observed.coverage[field]).sort(), Object.keys(expected.coverage[field]).sort())
      )
        throw new Error(`UI coverage counter inventory differs: ${path}`);
    const target: UiCoverage = result[path];
    for (const id of Object.keys(target.s)) target.s[id] += observed.coverage.s[id];
    for (const id of Object.keys(target.f)) target.f[id] += observed.coverage.f[id];
    for (const id of Object.keys(target.b)) {
      if (target.b[id].length !== observed.coverage.b[id].length)
        throw new Error(`UI coverage branch arity differs: ${path}`);
      target.b[id] = target.b[id].map((count: number, index: number): number => count + observed.coverage.b[id][index]);
    }
  }
}

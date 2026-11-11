import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { coverageReport, validateBrowserCoverage } from "./browser-coverage.ts";

const entrySchema = z.array(
  z.object({
    url: z.string(),
    scriptId: z.string(),
    source: z.string().optional(),
    functions: z.array(
      z.object({
        functionName: z.string(),
        isBlockCoverage: z.boolean(),
        ranges: z.array(
          z.object({
            startOffset: z.number().int().nonnegative(),
            endOffset: z.number().int().nonnegative(),
            count: z.number().int().nonnegative(),
          }),
        ),
      }),
    ),
  }),
);

export async function mergeBrowserCoverage(
  directories: string[],
  outputDir: string = "coverage/browser",
): Promise<void> {
  if (directories.length === 0)
    throw new Error("Browser coverage inputs are required.");
  const coverage = coverageReport(outputDir);
  for (const directory of directories) {
    const files: string[] = (await readdir(directory)).filter(
      (file: string): boolean => file.endsWith(".json"),
    );
    if (files.length === 0)
      throw new Error(`Missing browser coverage in ${directory}`);
    let entriesFound: boolean = false;
    for (const file of files) {
      const entries = entrySchema.parse(
        JSON.parse(await readFile(join(directory, file), "utf8")),
      );
      if (entries.length === 0) continue;
      entriesFound = true;
      await coverage.add(entries);
    }
    if (!entriesFound)
      throw new Error(`Missing browser coverage in ${directory}`);
  }
  await coverage.generate();
  validateBrowserCoverage(await readFile(join(outputDir, "lcov.info"), "utf8"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await mergeBrowserCoverage(process.argv.slice(2));
}

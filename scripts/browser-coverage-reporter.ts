import { rm, readFile, readdir } from "node:fs/promises";
import type { Reporter, FullResult } from "@playwright/test/reporter";
import { z } from "zod";
import { coverageReport, validateBrowserCoverage } from "./browser-coverage";

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

export default class BrowserCoverageReporter implements Reporter {
  private executed: number = 0;

  onTestEnd(): void {
    this.executed++;
  }

  async onBegin(): Promise<void> {
    await rm("coverage/browser", { recursive: true, force: true });
  }

  async onEnd(result: FullResult): Promise<void> {
    if (result.status !== "passed" || this.executed === 0) return;
    const coverage = coverageReport();
    const files: string[] = await readdir("coverage/browser/raw");
    for (const file of files) {
      const entries = entrySchema.parse(JSON.parse(await readFile(`coverage/browser/raw/${file}`, "utf8")));
      await coverage.add(entries);
    }
    await coverage.generate();
    const report: string = await readFile("coverage/browser/lcov.info", "utf8");
    validateBrowserCoverage(report);
  }
}

import { rmSync } from "node:fs";
import type { Reporter, FullResult } from "@playwright/test/reporter";
import { mergeBrowserCoverage } from "./merge-browser-coverage.ts";

export default class BrowserCoverageReporter implements Reporter {
  private executed: number = 0;

  onTestEnd(): void {
    this.executed++;
  }

  onBegin(): void {
    rmSync("coverage/browser", { recursive: true, force: true });
  }

  async onEnd(result: FullResult): Promise<void> {
    if (result.status !== "passed" || this.executed === 0) return;
    if (process.env.BROWSER_COVERAGE_SHARD === "1") return;
    await mergeBrowserCoverage(["coverage/browser/raw"]);
  }
}

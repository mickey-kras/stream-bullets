import { rm } from "node:fs/promises";
import type { Reporter, FullResult } from "@playwright/test/reporter";
import { mergeBrowserCoverage } from "./merge-browser-coverage.ts";

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
    if (process.env.BROWSER_COVERAGE_SHARD === "1") return;
    await mergeBrowserCoverage(["coverage/browser/raw"]);
  }
}

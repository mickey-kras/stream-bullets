import { CoverageReport } from "monocart-coverage-reports";

export function applicationSourcePath(sourcePath: string): string {
  const path: string = sourcePath.replaceAll("\\", "/");
  const index: number = path.indexOf("/app/");
  return index < 0 ? path : path.slice(index + 1);
}

export function coverageReport(outputDir: string = "coverage/browser"): CoverageReport {
  return new CoverageReport({
    outputDir,
    reports: ["lcovonly", "console-summary"],
    entryFilter: (entry): boolean => entry.url.startsWith("http://localhost:5173/assets/"),
    sourcePath: applicationSourcePath,
    outputFilter: (entry): boolean => entry.sourcePath.startsWith("app/"),
    sourceFilter: (sourcePath: string): boolean =>
      !sourcePath.includes("node_modules/") && applicationSourcePath(sourcePath).startsWith("app/"),
  });
}

export function validateBrowserCoverage(report: string): void {
  const sources: string[] = report.split("\n").filter((line: string): boolean => line.startsWith("SF:"));
  if (sources.length === 0 || sources.some((line: string): boolean => !line.startsWith("SF:app/"))) {
    throw new Error("Browser coverage must contain only mapped application sources.");
  }
}

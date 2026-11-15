import type { CoverageSummary } from "monocart-coverage-reports";

export function applicationAsset(url: string): boolean {
  return ["http://localhost:5173/assets/", "https://localhost:5174/assets/", "http://localhost:5175/assets/"].some(
    (prefix: string): boolean => url.startsWith(prefix),
  );
}

export function applicationSourcePath(sourcePath: string): string {
  const path: string = sourcePath.replaceAll("\\", "/");
  const index: number = path.indexOf("/app/");
  return index < 0 ? path : path.slice(index + 1);
}

export function productSource(sourcePath: string): boolean {
  const path: string = applicationSourcePath(sourcePath);
  return (
    path.startsWith("app/") &&
    /\.tsx?$/.test(path) &&
    !path.endsWith(".d.ts") &&
    !["app/server/", "app/components/station/", "app/lib/"].some((prefix: string): boolean =>
      path.startsWith(prefix),
    ) &&
    !["app/entry.server.tsx", "app/routes.ts"].includes(path)
  );
}

export function requireProductCoverage(summary: CoverageSummary): void {
  if (summary.lines.total === 0) throw new Error("Product UI coverage is missing.");
  for (const metric of ["lines", "statements", "functions", "branches"] as const) {
    const { covered, total } = summary[metric];
    if (total > 0 && covered / total < 0.9) {
      throw new Error(`Product UI ${metric} coverage ${((100 * covered) / total).toFixed(2)}% is below 90%.`);
    }
  }
}

export function validateBrowserCoverage(report: string): void {
  const sources: string[] = report.split("\n").filter((line: string): boolean => line.startsWith("SF:"));
  if (sources.length === 0 || sources.some((line: string): boolean => !line.startsWith("SF:app/"))) {
    throw new Error("Browser coverage must contain only mapped application sources.");
  }
}

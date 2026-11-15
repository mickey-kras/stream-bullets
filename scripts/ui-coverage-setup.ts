import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { afterAll, beforeAll } from "vitest";
import { resetUiCounters, snapshotUiCounters, writeUiSnapshot } from "./ui-coverage.ts";

if (process.env.UI_COVERAGE === "1") {
  resetUiCounters();
  beforeAll(async (): Promise<void> => {
    // Vitest cleans coverage/ after plugin initialization. Publish the cached inventory after that cleanup.
    await mkdir("coverage/ui-unit", { recursive: true });
    const temporary: string = `coverage/ui-unit/inventory-${randomUUID()}.tmp`;
    await copyFile(".react-router/ui-coverage/inventory.json", temporary);
    await rename(temporary, "coverage/ui-unit/inventory.json");
  });
  afterAll(async (): Promise<void> => {
    await writeUiSnapshot("coverage/ui-unit/raw", snapshotUiCounters(`unit:${randomUUID()}`));
  });
}

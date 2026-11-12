import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import safeTools from "./safe-path.cjs";

const trusted = dirname(fileURLToPath(import.meta.url));
// Expose reviewed tools only. Block Cargo/Ruby/PHP and npx from executing candidate or downloaded code.
process.env.PATH = safeTools.safePath(join(process.env.RUNNER_TEMP, "aislop-safe-bin"));
process.env.AISLOP_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";
process.env.AISLOP_NO_HISTORY = "1";
process.env.AISLOP_NO_UPDATE_NOTIFIER = "1";
const { loadConfig, scanCommand } = await import("aislop");
const config = loadConfig(trusted);
config.allowProjectLocalTools = false;
const result = await scanCommand(resolve(process.argv[2]), config, {
  verbose: false,
  json: false,
  sarif: process.argv[3] === "sarif",
  command: "ci",
});
process.exitCode = result.exitCode;

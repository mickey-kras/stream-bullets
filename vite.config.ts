import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { uiCoveragePlugin } from "./scripts/ui-coverage-plugin.ts";

export default defineConfig({
  plugins: [
    process.env.BROWSER_COVERAGE === "1" && uiCoveragePlugin("browser"),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
});

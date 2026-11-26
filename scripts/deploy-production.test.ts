import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const previousVersion: string = randomUUID();
const replacementVersion: string = randomUUID();

async function deploy(scenario: string): Promise<{ status: number | null; calls: string; output: string }> {
  const directory: string = await mkdtemp(join(tmpdir(), "production-deploy-"));
  try {
    const calls: string = join(directory, "calls");
    const deployment = (version: string): string =>
      JSON.stringify([{ created_on: "2026-11-01", versions: [{ version_id: version, percentage: 100 }] }]);
    await writeFile(
      join(directory, "pnpm"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *"deployments list"*)
    if [ "$SCENARIO" = "no-active-version" ]; then echo '[]'; exit; fi
    if [ "$SCENARIO" = "version-changed" ] && [ "$(grep -c 'deployments list' "$CALLS")" -gt 1 ]; then
      printf '%s\\n' '${deployment(replacementVersion)}'
    else
      printf '%s\\n' '${deployment(previousVersion)}'
    fi ;;
  *"migrations apply"*) [ "$SCENARIO" != "migration-fails" ] ;;
  *"rollback"*) [ "$SCENARIO" != "rollback-fails" ] ;;
  *"wrangler deploy"*) [ "$SCENARIO" != "deploy-fails" ] ;;
esac
`,
    );
    await writeFile(
      join(directory, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$*" == *"--dump-header"* ]]; then
  if [ "$SCENARIO" = "missing-marker" ]; then printf 'HTTP/2 200\\r\\n\\r\\n';
  elif [ "$SCENARIO" = "unsupported-marker" ]; then printf 'HTTP/2 200\\r\\nX-StreamBullets-Binary-Labels: 10\\r\\n\\r\\n';
  else printf 'HTTP/2 200\\r\\nx-streambullets-binary-labels: 1\\r\\n\\r\\n'; fi
elif [ "$SCENARIO" = "success" ] || { [ "$SCENARIO" != "restored-smoke-fails" ] && grep -q 'wrangler rollback' "$CALLS"; }; then
  printf '%s\\n' '<h1 id="landing-title">Stream Bullets</h1>'
else
  printf '%s\\n' 'Broken page'
fi
`,
    );
    await chmod(join(directory, "pnpm"), 0o755);
    await chmod(join(directory, "curl"), 0o755);
    const result = spawnSync("bash", [resolve("scripts/deploy-production.sh")], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CALLS: calls,
        SCENARIO: scenario,
        GITHUB_SHA: "revision",
      },
      encoding: "utf8",
    });
    return { status: result.status, calls: await readFile(calls, "utf8"), output: result.stdout + result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void describe("production deployment recovery", (): void => {
  void it("verifies the active reader before migrating and keeps a successful deployment", async (): Promise<void> => {
    const result = await deploy("success");
    assert.equal(result.status, 0);
    const calls: string[] = result.calls.trim().split("\n");
    assert.ok(calls[0].includes("deployments list"));
    assert.ok(calls[1].includes("--dump-header -"));
    assert.ok(calls[1].includes("Cache-Control: no-cache"));
    assert.ok(calls[2].includes("deployments list"));
    assert.ok(calls[3].includes("d1 migrations apply DB --env production --remote"));
    assert.ok(calls[4].includes("wrangler deploy --"));
    assert.ok(!result.calls.includes("wrangler rollback"));
  });

  void it("refuses a missing or unsupported reader marker before migrations or traffic changes", async (): Promise<void> => {
    for (const scenario of ["missing-marker", "unsupported-marker"]) {
      const result = await deploy(scenario);
      assert.notEqual(result.status, 0);
      assert.ok(!result.calls.includes("migrations apply"));
      assert.ok(!result.calls.includes("wrangler deploy --"));
      assert.ok(!result.calls.includes("wrangler rollback"));
      assert.ok(result.output.includes("binary-label compatible reader"));
    }
  });

  void it("rejects a changed active version before migrations or deployment", async (): Promise<void> => {
    const result = await deploy("version-changed");
    assert.notEqual(result.status, 0);
    assert.ok(!result.calls.includes("migrations apply"));
    assert.ok(!result.calls.includes("wrangler deploy --"));
    assert.ok(!result.calls.includes("wrangler rollback"));
    assert.ok(result.output.includes("active Worker changed"));
  });

  void it("stops on migration failure without changing the active Worker", async (): Promise<void> => {
    const result = await deploy("migration-fails");
    assert.notEqual(result.status, 0);
    assert.ok(result.calls.includes("migrations apply"));
    assert.ok(!result.calls.includes("wrangler deploy --"));
    assert.ok(!result.calls.includes("wrangler rollback"));
  });

  void it("restores the captured version and checks it after a failed smoke", async (): Promise<void> => {
    const result = await deploy("smoke-fails");
    assert.notEqual(result.status, 0);
    assert.ok(result.calls.includes(`wrangler rollback ${previousVersion}`));
    assert.equal(result.calls.match(/https:\/\/streambullets.com\/$/gm)?.length, 3);
    assert.ok(result.output.includes("Previous Worker restored"));
  });

  void it("stops before migrations or deployment without a rollback target", async (): Promise<void> => {
    const result = await deploy("no-active-version");
    assert.notEqual(result.status, 0);
    assert.ok(!result.calls.includes("migrations apply"));
    assert.ok(!result.calls.includes("wrangler deploy --"));
    assert.ok(!result.calls.includes("wrangler rollback"));
  });

  void it("reports a failed smoke check on the restored version", async (): Promise<void> => {
    const result = await deploy("restored-smoke-fails");
    assert.notEqual(result.status, 0);
    assert.ok(result.output.includes("Rollback smoke check failed"));
    assert.ok(!result.output.includes("Previous Worker restored"));
  });

  void it("recovers when deploy fails and reports rollback failure", async (): Promise<void> => {
    const failedDeploy = await deploy("deploy-fails");
    assert.notEqual(failedDeploy.status, 0);
    assert.ok(failedDeploy.calls.includes(`wrangler rollback ${previousVersion}`));
    const failedRollback = await deploy("rollback-fails");
    assert.notEqual(failedRollback.status, 0);
    assert.ok(failedRollback.output.includes("Automatic rollback failed"));
  });
});

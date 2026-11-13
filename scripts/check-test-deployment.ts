import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface DeploymentConfig {
  name: string;
  account_id: string;
  workers_dev: boolean;
  preview_urls: boolean;
  routes: { pattern: string; custom_domain: boolean }[];
  vars: Record<string, string>;
  d1_databases: { binding: string; database_name: string; database_id: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  durable_objects: { bindings: { name: string; class_name: string; script_name?: string }[] };
  ratelimits: { namespace_id: string }[];
  triggers: { crons: string[] };
  queues: { producers: unknown[]; consumers: unknown[] };
}

const config = JSON.parse(readFileSync("build/server/wrangler.json", "utf8")) as DeploymentConfig;
assert.equal(config.name, "stream-bullets-test");
assert.equal(config.account_id, "4c8f932bbf73d6901fbb40f559f6e1f4");
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.deepEqual(config.routes, [{ pattern: "test.streambullets.com", custom_domain: true }]);
assert.deepEqual(config.vars, {
  APP_ORIGIN: "https://test.streambullets.com",
  APP_ENV: "test",
  ADMIN_EMAILS: "admin@example.test",
  TEST_DATABASE_ID: "e475eb5b-db31-43bd-8692-5926711e8faa",
});
assert.equal(config.d1_databases.length, 1);
assert.equal(config.d1_databases[0].binding, "DB");
assert.equal(config.d1_databases[0].database_name, "stream-bullets-test");
assert.equal(config.d1_databases[0].database_id, config.vars.TEST_DATABASE_ID);
assert.deepEqual(config.r2_buckets, [{ binding: "IMAGES", bucket_name: "stream-bullets-test-images" }]);
assert.deepEqual(config.durable_objects.bindings, [{ name: "POLL_ROOMS", class_name: "PollRoom" }]);
assert.equal(config.ratelimits.length, 1);
assert.equal(config.ratelimits[0].namespace_id, "1003");
assert.deepEqual(config.triggers.crons, []);
for (const binding of ["services", "send_email", "kv_namespaces", "hyperdrive", "ai", "analytics_engine_datasets"]) {
  const value: unknown = (config as unknown as Record<string, unknown>)[binding];
  assert.ok(value === undefined || (Array.isArray(value) && value.length === 0), `Unexpected ${binding} binding`);
}
assert.deepEqual(config.queues, { producers: [], consumers: [] });

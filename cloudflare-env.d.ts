declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    POLL_HOST_EMAIL?: string;
    BUCKET?: R2Bucket;
  }
}

# Security policy

Report vulnerabilities through GitHub private vulnerability reporting.
If unavailable, arrange a private channel with the repository owner first.
Include the affected version, reproduction steps, and impact. Exclude secrets and personal data.

## Admin security keys

Admin needs a verified address in `ADMIN_EMAILS`.
With `ADMIN_STEP_UP=enforce`, every admin endpoint and page loader also checks a security key in the current session.
Admin content removal uses the same check and records a `moderation_actions` row.
Authors and page owners need no key to remove their content.

Missing or invalid `ADMIN_STEP_UP` values enforce checks. Production pins `enforce` in `wrangler.jsonc`.
Explicit `report` permits access without a key check.
Unchecked calls to admin endpoints record `step_up_missing`, the administrator, and the route.

- Challenges use 32 random bytes, expire after 2 minutes, and bind to a session and purpose. First use consumes them.
- Assertions must match `APP_ORIGIN` and its host's relying party ID hash. Keys must confirm user presence and verification through PIN or biometrics.
- Reported signature counters must increase. Compare-and-set updates prevent parallel assertion reuse.
- Step-up applies only to the session. Sign-out or session expiry ends it.
- First-key registration needs sign-in within 5 minutes, operator approval for that exact session, and a successful email send. Localhost and isolated tests omit the last two requirements.
- Later registrations need a key check within 2 minutes.
- Key removal needs a different key. The server refuses removal of the last key.
- `moderation_actions` records successful and failed checks, key changes, and moderation. It stores hashed session IDs.

### First-key enrollment

The operator confirms the administrator's identity through another channel.
The administrator signs in and opens `/admin?view=keys`. The page shows a session fingerprint.
Approve only that fingerprint and account for 5 minutes:

```sh
pnpm exec wrangler d1 execute DB --env production --remote --command "INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 'admin-key-enrollment:<SESSION_FINGERPRINT>', '<USER_ID>', (unixepoch()+300)*1000, unixepoch()*1000, unixepoch()*1000);"
```

First-key registration consumes the approval in the same transaction that stores the key.
An expired approval or a different session cannot use it.
Configure `NOTIFY_EMAIL` and `NOTIFY_FROM` before enrollment. The server sends a notice to the administrator's verified email before storing the first key.
If email fails, registration fails and keeps the approval for a retry. Never disable enforcement for enrollment.

### Recovery when the administrator loses every key

Recovery needs site-operator access to production D1 through Cloudflare.

1. Confirm the administrator's identity through another channel.
2. Delete the keys and record the reset:

   ```sh
   pnpm exec wrangler d1 execute DB --env production --remote --command "DELETE FROM session WHERE user_id='<USER_ID>'; DELETE FROM verification WHERE identifier LIKE 'admin-key-enrollment:%' AND value='<USER_ID>'; DELETE FROM passkey WHERE user_id='<USER_ID>'; INSERT INTO moderation_actions (id, target_kind, target_id, action, reason, actor_id, created_at) VALUES (lower(hex(randomblob(16))), 'passkey', '<USER_ID>', 'keys_reset', 'operator recovery', NULL, unixepoch()*1000);"
   ```

3. Ask the administrator to sign in again. Follow [first-key enrollment](#first-key-enrollment) and register two keys within 5 minutes.

## Channel connections

Streamers can connect Twitch, YouTube, and Kick channels for an activity feed. The server stores provider tokens encrypted with AES-256-GCM under keys in `CHANNEL_TOKEN_KEYS`, separate from `BETTER_AUTH_SECRET`. Connection changes need a recent sign-in. The Worker checks webhook signatures and timestamps on the raw body, and the ingest object drops repeated deliveries. See [Channel connections and activity](docs/channel-connections.md#threat-model) for the threat model, the limits, and the key rotation steps.

## Dependency licenses

Before release, review each dependency and its runtime dependency licenses. Record the review in the PR.
Check the permitted use, distribution, attribution, notices, and source disclosure. Ship mandatory notices.
Block release for unknown or incompatible licenses.

CI runs `node scripts/third-party-notices.ts --check` against `THIRD_PARTY_NOTICES.md`.
After dependency changes, regenerate the notices. Review changed licenses in the diff.
Vulnerability checks do not approve licenses. Repeat license review for changed licenses or new runtime dependencies.

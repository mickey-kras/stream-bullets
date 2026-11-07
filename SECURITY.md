# Security policy

Use GitHub private vulnerability reporting for security issues. If that feature is unavailable, contact the repository owner to arrange a private channel before sending details. Include the affected version, steps to reproduce the issue, and its impact. Do not include secrets or personal data.

## Admin security keys

Admin actions need an administrator account (a verified address in `ADMIN_EMAILS`). With `ADMIN_STEP_UP=enforce`, they also need a WebAuthn assertion from one of the account's security keys in the current session. The server checks this on every admin endpoint and in the Admin page loader. The browser never decides.

An administrator can also remove a topic, poll or comment from a streamer page. That removal uses the same check, and it writes a row to `moderation_actions`. Authors and page owners remove their own content without a key.

- Each assertion uses a random 32-byte challenge. The server stores the challenge per session and purpose for 2 minutes. It deletes the challenge on first use, so an attacker cannot use a response again.
- The server checks the origin against `APP_ORIGIN` and the relying party ID hash against its host name. The key must report user presence and user verification (PIN or biometrics).
- The signature counter must increase when the key reports one. A compare-and-set update stops two parallel uses of one assertion.
- The server stores the step-up time on the session row, not on the user. Another session of the same account does not inherit it. Sign-out or session expiry ends it.
- The server accepts a first key only within 5 minutes of a new sign-in. Later keys need a key check from the last 2 minutes. Removing a key needs a key check with a different key, and nobody can remove the last key.
- The `moderation_actions` table records each key check, failed check, key change and moderation action. Audit rows store a hash of the session id, not the id.

### Recovery when the administrator loses every key

Only the site operator can recover. The operator needs Cloudflare access to the production D1 database.

1. Confirm the administrator's identity through a channel other than the account.
2. Delete that account's keys and record the reset:

   ```sh
   pnpm exec wrangler d1 execute DB --env production --remote --command "DELETE FROM passkey WHERE user_id='<USER_ID>'; INSERT INTO moderation_actions (id, target_kind, target_id, action, reason, actor_id, created_at) VALUES (lower(hex(randomblob(16))), 'passkey', '<USER_ID>', 'keys_reset', 'operator recovery', NULL, unixepoch()*1000);"
   ```

3. Ask the administrator to sign out, sign in again and register two new keys within 5 minutes.

## Dependency licenses

Before a dependency ships, the maintainer must review its license and the licenses of its runtime dependencies. Record the review in the PR. Check the permitted use, distribution terms, attribution, license notices, and source disclosure requirements. Keep required notices with the release. Block the release if a license is unknown or its terms conflict with distribution of this application.

The dependency review checks for vulnerabilities. It does not approve licenses. Repeat the manual review when an update changes a license or adds a runtime dependency.

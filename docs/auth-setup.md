# Production sign-in setup

Better Auth reads provider credentials from Worker secrets. GitHub Actions needs no copy.
Keep credentials and administrator addresses out of Git.

## Administrator account

1. Forward a domain address to a verified inbox.
2. Create a Google account for that address with **Use your existing email**.
3. Complete verification through the forwarded message.
4. Store that address in `ADMIN_EMAILS`.

Forwarding preserves the Google identity. Signing in as the destination inbox does not grant administrator access.

## Google

1. Create a StreamBullets project in [Google Cloud Console](https://console.cloud.google.com/).
2. Configure branding under **Google Auth Platform**.
3. Set the name to **StreamBullets** and select the support contact.
4. Select **External** audience and give the developer contact.
5. Set the home page to `https://streambullets.com`.
6. Set the privacy page to `https://streambullets.com/privacy` and terms to `https://streambullets.com/terms`.
7. Authorize `streambullets.com`. If Google requests domain verification, complete it.
8. Use only `openid`, `email`, and `profile` scopes.
9. Under **Clients**, create a **Web application** client.
10. Set the redirect URI to `https://streambullets.com/api/auth/callback/google`.
11. Store `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secrets.
12. During testing, add the administrator as a test user. Test sign-in.
13. Publish through **Audience** and complete mandatory verification.

References: [Google provider](https://better-auth.com/docs/authentication/google), [consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent).

## Worker secrets

1. In Cloudflare **Workers & Pages**, open **stream-bullets**.
2. Open **Settings > Variables and Secrets**.
3. Add credentials as **Secret** values.
4. Deploy both provider values together.
5. Reload and confirm the provider button appears.

An incomplete pair causes a configuration error. Keep the existing `BETTER_AUTH_SECRET`.
Never paste secrets into issues, PRs, or chat.

## Twitch

1. Open the [developer console](https://dev.twitch.tv/console/apps).
2. Check the account email and enable two-factor authentication.
3. Select **Register Your Application** and enter a unique name.
4. Add redirect URL `https://streambullets.com/api/auth/callback/twitch`.
5. Select the website category. If Twitch requests a client type, select **Confidential**.
6. Create the app, open **Manage**, and generate a secret.
7. Store `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` as Worker secrets.
8. Test sign-in and sign-out with a separate viewer.

See [Twitch registration](https://dev.twitch.tv/docs/authentication/register-app/).
A different provider finds the same profile only with reliable email ownership proofs.

## Channel connections

Channel connections are separate from sign-in. They use their own redirect URIs and Worker secrets.
See [Channel connections and activity](channel-connections.md#setup) for the steps.
Add `CHANNEL_TOKEN_KEYS`, `TWITCH_EVENTSUB_SECRET`, `KICK_CLIENT_ID`, and `KICK_CLIENT_SECRET` as Worker secrets.
Add the channel redirect URIs to the existing Twitch app and Google client.

The YouTube scope `youtube.readonly` is sensitive. Google must check the app before all streamers can use it.

## Launch checks

1. Sign in as administrator and open `/admin`.
2. Create a personal profile through the account menu.
3. Confirm `/streamers` shows it while signed out.
4. Confirm `/@streambullets` loads the Ideas board.
5. With a separate viewer, submit and vote on an idea.
6. Change its status in Admin and confirm the public result.
7. Register two keys at `/admin?view=keys` using the README procedure.
8. Test both before setting `ADMIN_STEP_UP=enforce`.

Administrators need no waitlist approval. Other accounts start as viewers. Streamer applications need approval.

## Account linking and registration

Provider subject IDs identify Google and Twitch identities. Profiles keep internal user IDs.
Private emails have a unique normalized index, including concurrent registrations.
Normalization trims spaces and folds case. Dots and plus tags stay intact.

Automatic linking needs both verified-email flags. Adapters accept only Boolean `true` for OIDC `email_verified`.
Google also needs Gmail or a Workspace hosted-domain claim for reliable ownership.
Ordinary verification still supports forwarded-address administrators.
Third-party Google emails need explicit linking when ownership is not authoritative.
See [Google email authority](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

Automatic linking uses no trusted-provider list. It checks both proofs independently.
Server-only `emailLinkVerified` records reliable profile-email ownership. Client input cannot set it.
Original-provider sign-in sets it only for a reliable claim matching the profile email.

Explicit links with different emails do not promote that email.
Twitch requests `openid` and `user:read:email`. See [OIDC claims](https://dev.twitch.tv/docs/authentication/getting-tokens-oidc/).
Unverified collisions need provider verification or explicit linking from the original account.

The authority migration preserves accounts and verification flags without rebuilding the user table.
It backfills verified, single-provider Twitch accounts and verified, single-provider Gmail accounts only.
Other existing accounts need authoritative original-provider sign-in or explicit linking.
The normalized index rejects existing collisions. Resolve them before migration. Never merge automatically.

After recent sign-in, **Your profile** can connect any configured provider through its authorization flow.
Explicit linking proves control of the session and added provider subject, including providers without email.
The callback trusts that provider only for this operation. Automatic sign-in has no such exception.

Identities cannot move between profiles. Sign in to the owning profile or contact support.
Removing a method needs recent sign-in. Concurrent removals cannot remove the last method.

Registration needs age and terms acknowledgement before OAuth.
Eligibility is self-declared. The app requests no birthday scopes or birth dates.
Private acceptance records store the time, minimum age, and policy versions from `app/signup-policy.ts`.
Existing accounts remain usable. Their next acknowledged interactive sign-in records current acceptance without backdating.

New accounts can edit display names. Invalid provider names open a correction field.
Later sign-ins and links preserve profile edits.
Google and Twitch photos use validated imports with approved hosts, size limits, timeouts, and no redirects.
Failed imports use presets. **Your profile** supports photo replacement and removal.

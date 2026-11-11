# Production sign-in setup

The application uses Better Auth with provider credentials stored as Worker secrets.
GitHub Actions does not need a copy of these credentials.
Keep administrator addresses and credential values out of the repository.

## Administrator account

1. Configure a domain email address to forward to a verified inbox.
2. Create a Google account with that address. Select **Use your existing email** during registration.
3. Complete the email verification through the forwarded message.
4. Store that exact address in the Worker's `ADMIN_EMAILS` secret.

Forwarding does not change the identity returned by Google.
Signing in with the destination inbox account does not grant access to the administrator account.

## Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project for StreamBullets.
2. Open **Google Auth Platform** and configure the app branding.
3. Set the app name to **StreamBullets** and select the support contact.
4. Set the audience to **External** and supply the developer contact.
5. Set the home page to `https://streambullets.com`.
6. Set the privacy page to `https://streambullets.com/privacy` and the terms page to `https://streambullets.com/terms`.
7. Add `streambullets.com` as an authorized domain. If Google requests domain verification, complete it.
8. Use only the basic sign-in scopes: `openid`, `email`, and `profile`.
9. Under **Clients**, create a **Web application** client.
10. Set the authorized redirect URI to `https://streambullets.com/api/auth/callback/google`.
11. Store the client ID and secret in the Worker as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
12. Test sign-in with the administrator account. Add it as a test user while the app is in testing.
13. Publish the app for external users through **Audience**. Complete any verification that Google requires.

See [Google provider setup](https://better-auth.com/docs/authentication/google) and
[Google consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent).

## Worker secrets

1. Open the **stream-bullets** Worker under **Workers & Pages** in Cloudflare Dashboard.
2. Open **Variables and Secrets** under **Settings**.
3. Add each credential as a **Secret**, not a plain text variable.
4. Save both values for a provider in one configuration deployment.
5. Reload the site and confirm that the provider button appears.

A provider with only one credential causes a configuration error.
Keep the existing `BETTER_AUTH_SECRET`. Do not replace it during setup.
Never paste client secrets into an issue, a PR, or a chat.

## Twitch

1. Sign in to the [Twitch developer console](https://dev.twitch.tv/console/apps).
2. Complete verification of the Twitch account email and enable two-factor authentication.
3. Select **Register Your Application** and supply a unique app name.
4. Add `https://streambullets.com/api/auth/callback/twitch` as an OAuth redirect URL.
5. Select the category that describes the website. If asked for a client type, select **Confidential**.
6. Create the app, open **Manage**, and generate a client secret.
7. Store `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` as Worker secrets.
8. Test sign-in and sign-out with a separate viewer account.

See [Twitch app registration](https://dev.twitch.tv/docs/authentication/register-app/).
Use the same provider on later visits. The application does not link accounts across providers automatically.

## Launch checks

1. Sign in with the administrator account and open `/admin`.
2. Create the personal streamer profile through the account menu.
3. Open `/streamers` in a signed-out browser and confirm that the profile is visible.
4. Open `/@streambullets` and confirm that the Ideas board loads.
5. Sign in with a separate viewer account, submit an idea, and vote on it.
6. Use Admin to change the idea status and confirm that the public board shows it.
7. Register two security keys at `/admin?view=keys`, following the README instructions.
8. Test both keys before setting the Worker secret `ADMIN_STEP_UP` to `enforce`.

The administrator can create a personal profile without waitlist approval.
Other accounts can sign in as viewers. Streamer applications still need approval.

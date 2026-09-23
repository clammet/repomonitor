# GitHub authentication setup

RepoMonitor uses two separate GitHub registrations:

| Registration | Purpose | Configuration |
| --- | --- | --- |
| OAuth App | Sign-in, verified email discovery, and optional private-repository access for each user | Created manually in GitHub Developer settings; credentials are stored in the environment |
| GitHub App | Shared, authenticated polling of public repositories in production | Created or connected from RepoMonitor's super-admin Settings page; secrets are stored encrypted in the database |

Do not substitute one registration for the other. They use different callback
URLs and credentials.

## Choose `APP_URL` first

Set `APP_URL` to the URL users enter in their browser, without a trailing slash:

```dotenv
# Local development
APP_URL=http://localhost:3000

# Production example
APP_URL=https://repomonitor.example.com
```

GitHub redirects the browser to this URL, so it must be reachable from the
user's browser. Use HTTPS in production. If `APP_URL` changes, update or
recreate the registrations described below before trying to sign in.

The OAuth App examples use `http://localhost:3000`. GitHub App registration is
production-only and uses the public HTTPS `APP_URL`.

## 1. Create the OAuth App

The OAuth App handles RepoMonitor sign-in and user-specific access to private
repositories.

1. In GitHub, open **Settings > Developer settings > OAuth Apps**.
2. Select **New OAuth App** (or **Register a new application**).
3. Enter these values:

   | GitHub field | Value |
   | --- | --- |
   | Application name | `RepoMonitor` or an environment-specific name such as `RepoMonitor (local)` |
   | Homepage URL | `http://localhost:3000` |
   | Application description | Optional |
   | Authorization callback URL | `http://localhost:3000/api/auth/github/callback` |
   | Enable Device Flow | **Off** |

4. Select **Register application**.
5. Copy the **Client ID**.
6. Generate a client secret and copy it immediately.
7. Add both values to `.env`:

   ```dotenv
   GITHUB_CLIENT_ID=your-oauth-app-client-id
   GITHUB_CLIENT_SECRET=your-oauth-app-client-secret
   ```

8. Restart RepoMonitor after changing the environment.

### OAuth scopes

Scopes are not selected on the OAuth App registration page. RepoMonitor asks
for them when a user signs in:

- **Public repositories only:** `read:user user:email`
- **Public and private repositories:** `repo read:user user:email`

The classic `repo` scope is broad, so it is requested only when the user
explicitly selects private-repository access. Changing that selection replaces
the user's stored token.

An OAuth App supports only one configured callback URL. Use a separate OAuth
App, client ID, and client secret for local development and production rather
than repeatedly changing a shared registration.

## 2. Register the public-polling GitHub App in production

For a new GitHub App, RepoMonitor uses GitHub's App Manifest flow so the
generated client ID and secret can be saved automatically. If you already have
a public-polling GitHub App, use **Connect existing app** as described below.

The registration and authorization controls are disabled in development.
GitHub validates the manifest's webhook URL as publicly reachable even when
webhook delivery is inactive, so a localhost manifest is rejected. Development
instead polls public repositories anonymously, with a 60-request-per-hour
primary limit for the server IP. Production uses the authorized app user token,
whose normal primary limit is 5,000 requests per hour.

Before registering it:

1. Complete the OAuth App setup above.
2. Add the GitHub login that will administer RepoMonitor to `.env`:

   ```dotenv
   SUPER_ADMIN_GITHUB_LOGINS=octocat
   ```

   Multiple logins can be separated with commas. Matching is
   case-insensitive.

3. Run RepoMonitor in production with a publicly reachable HTTPS `APP_URL`.
4. Sign in to RepoMonitor with that GitHub account.
5. Open **Settings** and select **Register GitHub App** under **Public
   repository polling**.
6. Review and create the prefilled app on GitHub. The manifest creates it under
   the currently signed-in personal GitHub account.
7. After GitHub returns to RepoMonitor, select **Authorize GitHub App**.
8. Authorize it with the same GitHub account as the active RepoMonitor
   super-admin session.

No GitHub App ID, client ID, client secret, private key, or webhook secret needs
to be copied into `.env`. RepoMonitor saves the returned app credentials and
user tokens encrypted in the database. Keep `ENCRYPTION_KEY` stable after
registration.

### Connect an existing GitHub App

You do not need to delete or recreate your GitHub App after a fresh deployment.

1. Open **Settings > Public repository polling > Connect existing app** in
   RepoMonitor while signed in as a super-admin in production.
2. In GitHub, open **Settings > Developer settings > GitHub Apps** and edit the
   existing public-polling app. For an organization-owned app, use the
   organization's settings.
3. Set its user authorization callback URL to the value shown in RepoMonitor.
   This uses the current `APP_URL`, ending in
   `/api/admin/github-app/authorize/callback`.
4. Enter the app's **App ID**, **slug** (the last part of
   `https://github.com/apps/SLUG`), **Client ID**, and **client secret** in
   RepoMonitor. Generate a new client secret in GitHub if you no longer have the
   original. Use the GitHub App credentials, not the separate sign-in OAuth App
   credentials. No private key is needed.
5. Select **Save app credentials**, then **Authorize GitHub App**. Authorization
   verifies the credentials with GitHub; saving alone does not enable polling.
   Use the same GitHub account as the active RepoMonitor super-admin session.

The form remains available so you can correct credentials or connect a
different app. Saving replaces the stored connection and clears its previous
authorization; public polling resumes after authorization succeeds. Existing
apps should use the permissions and settings listed below.

To abandon the existing-app setup, select **Create new GitHub App** in the same
section. This starts the new-app registration flow even when credentials are
already saved. Completing registration replaces the saved credentials and
clears the previous authorization; then select **Authorize GitHub App** to
authorize the newly created app. Cancelling registration leaves the saved
connection intact. RepoMonitor does not delete the previous app from GitHub.

For normal redeployments, retain the database volume and the same
`ENCRYPTION_KEY`. RepoMonitor then remembers the existing app and its encrypted
tokens without reconnecting. If **Register GitHub App** reappears in production,
the active database has no saved app configuration; check that the deployment
is using the original database volume.

### Expected GitHub App settings

The manifest supplies these settings:

| GitHub setting | Expected value |
| --- | --- |
| GitHub App name | `RepoMonitor Public Poller` |
| Homepage URL | `https://repomonitor.example.com` |
| User authorization callback URL | `https://repomonitor.example.com/api/admin/github-app/authorize/callback` |
| Expire user authorization tokens | **On**; RepoMonitor refreshes expiring tokens |
| Request user authorization (OAuth) during installation | **Off**; RepoMonitor starts authorization separately |
| Enable Device Flow | **Off** |
| Setup URL | Blank |
| Redirect on update | **Off** |
| Webhook Active | **Off** |
| Webhook URL | `https://repomonitor.example.com/api/github-app/webhook` (present but inactive) |
| Repository permissions | All **No access** |
| Organization permissions | All **No access** |
| Account permissions | All **No access** |
| Subscribe to events | None |
| Where can this GitHub App be installed? | **Only on this account** |

The manifest registration itself returns to:

```text
https://repomonitor.example.com/api/admin/github-app/manifest/callback
```

This manifest callback is used only while creating the app. It is different
from the user authorization callback displayed in the GitHub App's settings.

The GitHub App deliberately has no repository permissions, active webhooks, or
installations. Once a super-admin authorizes it, its user access token has
implicit read access to public resources and receives an authenticated API rate
limit. Private repositories continue to use each subscriber's OAuth App token.

## Callback URL reference

For `APP_URL=https://repomonitor.example.com`, the complete set of GitHub URLs
is:

| Flow | URL |
| --- | --- |
| OAuth App user callback | `https://repomonitor.example.com/api/auth/github/callback` |
| GitHub App manifest registration callback | `https://repomonitor.example.com/api/admin/github-app/manifest/callback` |
| GitHub App user authorization callback | `https://repomonitor.example.com/api/admin/github-app/authorize/callback` |
| GitHub App webhook URL (inactive) | `https://repomonitor.example.com/api/github-app/webhook` |

## Troubleshooting

### `redirect_uri_mismatch`

Check all of the following:

- `APP_URL` uses the same scheme, hostname, and port as the URL registered in
  GitHub.
- `APP_URL` has no trailing slash.
- The OAuth App callback ends in `/api/auth/github/callback`.
- The GitHub App callback ends in
  `/api/admin/github-app/authorize/callback`.
- The server was restarted after an environment change.

RepoMonitor sends an explicit redirect URI during both authorization flows, so
the registered callback must match it.

### The GitHub App registration or authorization option is missing

In development, registration is intentionally disabled and public polling is
anonymous. In production, confirm that the signed-in GitHub login appears in
`SUPER_ADMIN_GITHUB_LOGINS`. Only super-admins can use these controls.

### The GitHub App is registered but public polling is not ready

Registration and authorization are separate steps. Return to RepoMonitor
**Settings** and select **Authorize GitHub App**. Use the same GitHub account
that is signed in to RepoMonitor.

### A repository request reports rejected or revoked authorization

A GitHub `401` means the request was rejected; it does not by itself prove that
the app registration needs to be replaced. RepoMonitor reloads the current
authorization, attempts a token refresh when available, and retries the
operation once. If GitHub still rejects it, RepoMonitor checks the token with
`GET /user` before clearing that authorization. A late failure from an older
request cannot clear a newer authorization.

If the token cannot be recovered, select **Authorize GitHub App** or
**Reauthorize** in Settings for the current app. Do not recreate the app. Older
versions cleared the saved authorization on the first `401`, so after upgrading
you may need to authorize it once more.

If the error persists immediately after authorization, check the server log
entry **Public repository request rejected by GitHub**. It contains the failed
endpoint, HTTP status, and GitHub request ID, without credentials or tokens.
These distinguish the failed repository request from the successful sign-in
check and can help investigate the rejection with GitHub.

### A private organization repository is unavailable

The user must select private-repository access in RepoMonitor. The organization
may also require approval for the OAuth App or an active SAML SSO session.
These controls belong to the organization and are separate from the
public-polling GitHub App.

## GitHub documentation

- [Creating an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [Authorizing OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

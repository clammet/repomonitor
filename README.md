# RepoMonitor

RepoMonitor is a small, self-hosted web application that watches GitHub
repositories for precise changes and emails subscribed users when a condition
matches.

## What is implemented

- GitHub OAuth sign-in with optional private-repository authorization
- A super-admin-managed, read-only GitHub App for shared public polling
- Public and private repository subscriptions
- Commit and release event streams
- Case-insensitive text matching across:
  - commit messages and changed file patches
  - release names, notes, intervening commit messages, and changed file patches
- File/line monitoring with an exact captured baseline
- Shared public polling: one GitHub App request stream per repository/event
- Isolated private polling: every subscriber uses only their own OAuth token
- Durable access-error states with user-visible recovery and email alerts
- Daily scheduled polls with a database lease, plus a super-admin “Poll now”
  action
- Deduplicated notifications, crash recovery, retry handling, and configurable
  random delays between sends
- GitHub notification addresses and custom addresses with email verification
- Verification is confirmed by the signed-in account that requested it, so
  opening the link alone — by a person or a mail security scanner — never
  activates an address
- Local `sendmail` delivery by default
- Super-admin Google OAuth setup for a global Gmail API sender
- Responsive account, subscription, condition, and admin screens
- SQLite persistence, Prisma migrations, a multi-stage Docker image, and
  Docker Compose

## How line monitoring works

When a line condition is created, RepoMonitor resolves the current event
reference:

- commits use the default branch head
- releases use the latest published release tag, falling back to the default
  branch when no release exists

It stores the resolved commit SHA and the exact content of the selected
one-based line. A file path and line can be entered manually, or populated by
pasting a GitHub `blob` URL with a line anchor such as `#L142`.

Line conditions have three notification triggers, all enabled by default:

- **Removed/readded** — alerts when the captured content stops appearing
  anywhere in the file and again when it reappears. Its current location is
  updated whenever the content is present.
- **Moved** — alerts whenever the captured content relocates from its last
  tracked line, including when it moves back to the line captured during setup.
  Exact-line matches are preferred, with substring matches used as a fallback.
- **Changed** — the content at the numbered line differs from the preceding
  observation. This always monitors the original line number, independently of
  the moving and removed/readded location trackers.

Each new commit or release resolves to a commit SHA and fetches the whole file
so these states can be distinguished. The latest value at the original line,
the latest moved location, and the current removed/readded location are saved
after every observation. The original baseline remains stored for audit
context.

For releases, RepoMonitor resolves the release tag to its commit and compares
that commit with the preceding release commit. This makes both line and text
conditions operate against the code that was actually released.

## Local setup

Requirements:

- Node.js 22+
- pnpm 10+
- a GitHub OAuth App
- a working local `sendmail` command, unless Gmail is connected

Install and configure:

```sh
pnpm install
cp .env.example .env
pnpm db:deploy
pnpm dev
```

Register these callback URLs in the provider consoles:

- GitHub: `http://localhost:3000/api/auth/github/callback`
- Google: `http://localhost:3000/api/admin/gmail/callback`

The public-polling GitHub App is registered from the super-admin Settings page.
Its manifest automatically supplies the registration and user-authorization
callback URLs based on `APP_URL`.

Generate real secrets before starting:

```sh
openssl rand -hex 32
openssl rand -base64 32
```

Use those values for `SESSION_SECRET` and `ENCRYPTION_KEY` respectively.
Changing `ENCRYPTION_KEY` after provider tokens have been stored makes those
tokens unreadable.

### GitHub OAuth

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` for a normal GitHub OAuth App.
See [GitHub authentication setup](docs/github-authentication.md) for the exact
registration fields, callback URLs, Device Flow setting, and public-polling
GitHub App options.

At sign-in, users choose one of two grants:

- public only: `read:user` and `user:email`
- public and private: `repo`, `read:user`, and `user:email`

The stored token is replaced each time the user changes this choice. The broad
classic `repo` scope is only requested when the user explicitly enables private
repository monitoring.

Set `SUPER_ADMIN_GITHUB_LOGINS` to a comma-separated list of GitHub logins:

```dotenv
SUPER_ADMIN_GITHUB_LOGINS=octocat,hubot
```

Matching is case-insensitive. Only these users see the GitHub App setup, Gmail
sender, and manual poll controls.

### Public polling GitHub App

Development mode deliberately does not register or authorize a GitHub App:
GitHub requires the manifest's webhook URL to be reachable over the public
Internet, even though RepoMonitor disables webhook delivery. Public
repositories are therefore polled anonymously in development, using GitHub's
60-request-per-hour limit for the server IP.

In production, after signing in as a super-admin, open Settings:

1. Select **Register GitHub App**. RepoMonitor uses GitHub's manifest flow to
   create an app with no repository permissions and no active webhooks.
2. Select **Authorize GitHub App** and authorize it with the same GitHub account
   used for the RepoMonitor super-admin session.

RepoMonitor stores the resulting GitHub App user access and refresh tokens
encrypted. GitHub Apps acting on behalf of a user have implicit read access to
public resources, so the app does not need to be installed on or granted access
to any repositories. The token is used only to make public REST API requests
with an authenticated rate limit instead of GitHub's anonymous limit.

### Email

By default, notifications are piped to `SENDMAIL_PATH` using `-t -i`.
`MAIL_FROM` controls the sender header.

To enable the optional global Gmail sender:

1. Create a Google OAuth web application.
2. Enable the Gmail API.
3. Add the Google callback URL shown above.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Sign in as a super-admin, open Settings, and connect the sender address.

The app requests offline access plus the minimal `gmail.send` scope, supports
incremental authorization, verifies the scopes actually granted, and stores
the refresh token encrypted. Removing the Google sender immediately returns
delivery to sendmail.

Production deployments can also register the signed security-event receiver at
`/api/google/risc` for Google Cross-Account Protection. Matching account or
token security events disconnect the Gmail sender. The registration command and
Google Cloud setup are documented in the guide below.

See [Google API and Gmail sender setup](docs/google-api-setup.md) for the exact
Google Cloud project, audience, scopes, OAuth client, callback, and test-user
configuration.

`EMAIL_DELAY_MIN_MS` and `EMAIL_DELAY_MAX_MS` define a random delay before each
queued notification. Failed deliveries retry up to three polling cycles.

## Polling behavior

The default schedule is 03:17 UTC each day:

```dotenv
POLL_CRON=17 3 * * *
POLL_TIMEZONE=UTC
```

Public polling state belongs to a repository and event type. In development,
the worker uses anonymous REST requests; in production, it uses the configured
GitHub App user token. It fetches each shared stream once, then evaluates all
active public subscribers' conditions without refetching it. Public repositories
never need to be selected in a GitHub App installation.

Private polling state belongs to a subscription and event type. Each private
subscriber is polled independently with that user's OAuth token. Tokens are
never shuffled, selected from another subscriber, or used as fallbacks.

GitHub `401`, non-rate-limit `403`, `404`, and `410` responses are treated as
durable access failures. A public failure pauses every subscription to that
repository; a private failure pauses only the affected user's subscription. The
worker does not retry paused subscriptions automatically. It displays the error,
queues an email alert, and provides a **Retry repository access** action.
Rate-limit responses, server failures, and network errors remain transient and
are retried on the next polling cycle. The REST client budgets 60 anonymous
requests per hour and 5,000 authenticated requests per credential by default,
then follows GitHub's rate-limit limit, remaining, reset, and retry headers.

The current worker supports up to 1,000 commits or releases between checks and
uses the patches GitHub returns (GitHub can omit patches for binary or very
large diffs). A single SQLite-backed instance is the intended initial
deployment model.

## Docker deployment

Create `.env`, then run:

```sh
docker compose up --build
```

The Compose file mounts `/app/data` as a named volume. Prisma migrations run
before the server starts. Set `APP_URL` to the externally reachable HTTPS URL
and register its callback URLs with GitHub and Google.

To run the published image instead of building locally, use
`docker-compose.deploy.yml`, which pins the image by digest:

```sh
docker compose -f docker-compose.deploy.yml up -d
```

The container includes a sendmail-compatible command, but production operators
must configure its mail transfer route or connect Gmail in the super-admin
settings.

### Build and publish the image

Build a local image for the current machine:

```sh
pnpm docker:build
```

This tags the image as `ghcr.io/clammet/repomonitor:latest`. To publish it,
create a GitHub personal access token (classic) with `write:packages`, then log
Docker in to GitHub Container Registry:

```sh
export CR_PAT=YOUR_TOKEN
printf '%s' "$CR_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Build and publish a multi-platform image for Linux AMD64 and ARM64:

```sh
pnpm docker:publish
```

The image name, tag, and target platforms can be overridden when needed:

```sh
DOCKER_TAG=0.1.0 pnpm docker:publish
DOCKER_IMAGE=ghcr.io/another-owner/repomonitor pnpm docker:publish
DOCKER_PLATFORMS=linux/amd64 pnpm docker:publish
```

See GitHub's
[Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
for token, package permission, and visibility details.

### Automated x64 image

The GitHub Actions workflow in `.github/workflows/docker.yml` builds
`linux/amd64` images only when commits are pushed to `main`. Each successful
build publishes `latest` and `sha-<commit>` tags to
`ghcr.io/clammet/repomonitor`.

Publishing uses the workflow's built-in `GITHUB_TOKEN`; no registry secret is
required. The repository grants the job only `contents: read` and
`packages: write` permissions.

## Dependency management

Every dependency is pinned exactly: npm packages through the lockfile, pnpm by
checksum, the base image and GitHub Actions by digest, and the deployed image
by digest. A self-hosted Renovate run opens a PR for each upstream release, CI
proves it, and green minor or patch PRs merge themselves while majors wait for
review. Trivy scans the published image weekly.

Renovate authenticates as a GitHub App; the secret setup is documented in
`.github/workflows/renovate.yml`. Merging relies on repository settings:
auto-merge is enabled and a branch protection rule on `main` requires the
"Lint, test, and build" and "Build Docker image" checks, with admin
enforcement off so direct pushes by the owner still work. If a CI job is
renamed, update the required checks in the branch protection rule to match,
or PRs will block forever.

## Development

```sh
pnpm test
pnpm lint
pnpm build
```

The application uses Next.js App Router, TypeScript, Prisma, SQLite, Vitest,
and `node-cron`.

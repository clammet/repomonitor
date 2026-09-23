import { EmailSource } from "@prisma/client";

import { Flash } from "@/app/_components/flash";
import { Header } from "@/app/_components/header";
import { GitHubAppConnection } from "@/app/settings/github-app-connection";
import {
  requireUser,
  userIsAdmin,
} from "@/lib/auth/session";
import { config, googleOAuthConfigured, isProduction } from "@/lib/config";
import { db } from "@/lib/db";
import { hasPrivateRepositoryAccess } from "@/lib/github/access";
import { GITHUB_DEFAULT_HOURLY_LIMIT } from "@/lib/github/rate-limit";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const [user, query] = await Promise.all([requireUser(), searchParams]);
  const isAdmin = userIsAdmin(user.githubLogin);
  const githubAppEnabled = isProduction();
  const [gmail, lastLease, githubApp] = isAdmin
    ? await Promise.all([
        db.gmailSender.findUnique({ where: { id: "global" } }),
        db.pollLease.findUnique({ where: { id: "daily" } }),
        db.gitHubAppConfiguration.findUnique({ where: { id: "global" } }),
      ])
    : [null, null, null];
  const privateRepositoryAccess = Boolean(
    user.githubCredential &&
      !user.githubCredential.invalidAt &&
      hasPrivateRepositoryAccess(user.githubCredential.scopes),
  );

  return (
    <>
      <Header user={user} />
      <main className="shell settings-page">
        <Flash notice={query.notice} error={query.error} />
        <section className="page-title">
          <p className="eyebrow">Account</p>
          <h1>Settings</h1>
          <p>Choose where alerts land and manage service-level delivery.</p>
        </section>

        <section className="settings-card">
          <header>
            <span className="settings-number">01</span>
            <div>
              <h2>Notification email</h2>
              <p>Alerts are sent only to a verified address you select.</p>
            </div>
          </header>
          <div className="email-list">
            {user.emailAddresses.map((address) => (
              <form
                action="/api/email/addresses/select"
                method="post"
                className={`email-option ${user.notificationEmailId === address.id ? "email-selected" : ""}`}
                key={address.id}
              >
                <input type="hidden" name="emailAddressId" value={address.id} />
                <span className="radio-mark" aria-hidden="true" />
                <div>
                  <strong>{address.email}</strong>
                  <span>
                    {address.source === EmailSource.GITHUB ? "GitHub" : "Custom"}
                    {" · "}
                    {address.verifiedAt ? "Verified" : "Awaiting verification"}
                  </span>
                </div>
                <span className="email-actions">
                  {address.verifiedAt ? (
                    <button
                      className="button button-secondary button-small"
                      disabled={user.notificationEmailId === address.id}
                    >
                      {user.notificationEmailId === address.id
                        ? "Selected"
                        : "Use"}
                    </button>
                  ) : (
                    <span className="pending-pill">Pending</span>
                  )}
                  {address.source === EmailSource.CUSTOM ? (
                    <button
                      className="icon-button email-remove-button"
                      type="submit"
                      formAction="/api/email/addresses/delete"
                      aria-label={`Remove ${address.email}`}
                      title="Remove custom email address"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6" />
                      </svg>
                    </button>
                  ) : null}
                </span>
              </form>
            ))}
          </div>
          <form className="inline-form" action="/api/email/addresses" method="post">
            <label>
              Add a custom address
              <span>
                <input
                  type="email"
                  name="email"
                  placeholder="you@example.com"
                  required
                />
                <button className="button button-primary" type="submit">
                  Send verification
                </button>
              </span>
            </label>
          </form>
        </section>

        <section className="settings-card">
          <header>
            <span className="settings-number">02</span>
            <div>
              <h2>GitHub connection</h2>
              <p>The stored token supplies read access for background checks.</p>
            </div>
          </header>
          <div className="connection-row">
            <span className="repo-monogram">{user.githubLogin[0]?.toUpperCase()}</span>
            <div>
              <strong>@{user.githubLogin}</strong>
              <span>
                Connected ·{" "}
                {privateRepositoryAccess
                  ? "private repository access enabled"
                  : "profile and email access only"}
              </span>
            </div>
            <a
              className="button button-secondary button-small"
              href={`/api/auth/github?private=${privateRepositoryAccess ? "false" : "true"}&returnTo=/settings`}
            >
              {privateRepositoryAccess
                ? "Disable private access"
                : "Enable private access"}
            </a>
          </div>
          <p className="form-hint">
            {githubAppEnabled
              ? "Public repositories are polled through the service GitHub App."
              : "In development, public repositories are polled anonymously."}{" "}
            Changing this setting replaces the stored user token and may pause
            existing private subscriptions.
          </p>
        </section>

        {isAdmin ? (
          <section className="settings-card admin-card">
            <header>
              <span className="settings-number">A</span>
              <div>
                <p className="eyebrow">Super-admin</p>
                <h2>Service delivery</h2>
                <p>
                  Configure public polling, the sender, and the daily job.
                </p>
              </div>
            </header>
            <div className="admin-grid">
              <div className="admin-block">
                <small>PUBLIC REPOSITORY POLLING</small>
                {!githubAppEnabled ? (
                  <>
                    <p>
                      Development mode uses anonymous GitHub REST requests for
                      public repositories. GitHub App registration requires a
                      publicly reachable URL.
                    </p>
                    <button
                      className="button button-primary button-small"
                      disabled
                    >
                      Register GitHub App
                    </button>
                    <span className="form-hint">
                      Anonymous polling is limited to{" "}
                      {GITHUB_DEFAULT_HOURLY_LIMIT.anonymous} requests per hour
                      for the server&apos;s IP address. RepoMonitor stops
                      requesting when GitHub reports that budget is exhausted
                      and resumes after the reset time.
                    </span>
                  </>
                ) : githubApp ? (
                  githubApp.accessTokenEncrypted ? (
                    <>
                      <div className="connected-sender">
                        <span className="github-app-mark">GH</span>
                        <div>
                          <strong>{githubApp.slug}</strong>
                          <span>
                            Authorized as @{githubApp.authorizedGithubLogin} ·
                            public data only
                          </span>
                        </div>
                      </div>
                      <div className="button-row">
                        <a
                          className="button button-secondary button-small"
                          href="/api/admin/github-app/authorize"
                        >
                          Reauthorize
                        </a>
                        <a
                          className="button button-secondary button-small"
                          href={`https://github.com/settings/apps/${githubApp.slug}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Manage GitHub App
                        </a>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>
                        The GitHub App is registered. Authorize it as this
                        super-admin to give public polling an authenticated API
                        rate limit.
                      </p>
                      <a
                        className="button button-primary button-small"
                        href="/api/admin/github-app/authorize"
                      >
                        Authorize GitHub App
                      </a>
                    </>
                  )
                ) : (
                  <>
                    <p>
                      Register or connect a GitHub App for authenticated public API
                      requests. It requests no repository permissions and does
                      not need to be installed on repositories.
                    </p>
                    <form action="/api/admin/github-app/register" method="post">
                      <button className="button button-primary button-small">
                        Register GitHub App
                      </button>
                    </form>
                  </>
                )}
                {githubAppEnabled ? (
                  <GitHubAppConnection
                    app={githubApp}
                    callbackUrl={`${config().APP_URL}/api/admin/github-app/authorize/callback`}
                  />
                ) : null}
                {githubAppEnabled ? (
                  <span className="form-hint">
                    Public repositories remain public. The app user token only
                    replaces GitHub&apos;s anonymous REST API limit with an
                    authenticated limit.
                  </span>
                ) : null}
              </div>
              <div className="admin-block">
                <small>GOOGLE EMAIL SENDER</small>
                {gmail ? (
                  <>
                    <div className="connected-sender">
                      <span className="google-mark">G</span>
                      <div>
                        <strong>{gmail.email}</strong>
                        <span>Gmail API · connected</span>
                      </div>
                    </div>
                    <form
                      id="gmail-test-email"
                      className="gmail-test-form"
                      action="/api/admin/gmail/test"
                      method="post"
                    >
                      <label>
                        Test recipient
                        <input
                          type="email"
                          name="to"
                          placeholder="recipient@example.com"
                          defaultValue={user.notificationEmail?.email ?? ""}
                          required
                        />
                      </label>
                    </form>
                    <div className="button-row gmail-action-row">
                      <button
                        className="button button-primary button-small"
                        type="submit"
                        form="gmail-test-email"
                      >
                        Send test email
                      </button>
                      <form action="/api/admin/gmail/remove" method="post">
                        <button className="button button-secondary button-small">
                          Revert to sendmail
                        </button>
                      </form>
                    </div>
                  </>
                ) : (
                  <form action="/api/admin/gmail/start" method="post">
                    <p>
                      Currently using the local sendmail interface. Connect a
                      Google account to replace it for all future messages.
                    </p>
                    <label>
                      Google account
                      <input
                        type="email"
                        name="email"
                        placeholder="sender@example.com"
                        disabled={!googleOAuthConfigured()}
                        required
                      />
                    </label>
                    <button
                      className="button button-primary button-small"
                      disabled={!googleOAuthConfigured()}
                    >
                      Connect with Google
                    </button>
                    {!googleOAuthConfigured() ? (
                      <span className="form-hint">
                        Add Google OAuth credentials to enable this option.
                      </span>
                    ) : null}
                  </form>
                )}
              </div>
              <div className="admin-block">
                <small>DAILY POLL</small>
                <p>
                  {lastLease?.lastRunAt
                    ? `Last completed ${lastLease.lastRunAt.toLocaleString("en-AU", { timeZone: "UTC" })} UTC.`
                    : "No poll has completed yet."}
                </p>
                <form action="/api/admin/poll" method="post">
                  <button className="button button-primary button-small">
                    Poll now
                  </button>
                </form>
                <span className="form-hint">
                  This can take a few minutes and sends real notifications.
                </span>
              </div>
            </div>
          </section>
        ) : null}
      </main>
    </>
  );
}

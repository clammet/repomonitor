type AppDetails = {
  appId: string;
  slug: string;
  clientId: string;
};

export function GitHubAppConnection({
  app,
  callbackUrl,
}: {
  app: AppDetails | null;
  callbackUrl: string;
}) {
  return (
    <details className="github-app-connection">
      <summary className="button button-secondary button-small">
        Connect existing app
      </summary>
      <form action="/api/admin/github-app/connect" method="post">
        <p>
          Open your existing app in GitHub Settings → Developer settings →{" "}
          <a href="https://github.com/settings/apps" target="_blank" rel="noreferrer">
            GitHub Apps
          </a>
          . Use its GitHub App credentials, not your sign-in OAuth App credentials.
          Generate a new client secret there if you no longer have the original.
        </p>
        <label>
          User authorization callback URL
          <input value={callbackUrl} readOnly />
          <small>Set this callback URL in the existing app before authorizing.</small>
        </label>
        <label>
          App ID
          <input
            name="appId"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            maxLength={20}
            defaultValue={app?.appId}
            required
          />
        </label>
        <label>
          App slug
          <input
            name="slug"
            placeholder="repomonitor-public-poller"
            maxLength={100}
            defaultValue={app?.slug}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <small>The last part of the app&apos;s public URL: github.com/apps/SLUG.</small>
        </label>
        <label>
          Client ID
          <input
            name="clientId"
            maxLength={255}
            defaultValue={app?.clientId}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </label>
        <label>
          Client secret
          <input
            type="password"
            name="clientSecret"
            maxLength={512}
            autoComplete="new-password"
            required
          />
        </label>
        {app ? (
          <p>
            Saving replaces the current connection and pauses public polling
            until you authorize the app again.
          </p>
        ) : null}
        <button className="button button-primary button-small">
          Save app credentials
        </button>
      </form>
    </details>
  );
}

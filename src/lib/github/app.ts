import "server-only";

import type { GitHubAppConfiguration } from "@prisma/client";
import { z } from "zod";

import { config, isProduction } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { createGitHubAppManifest } from "@/lib/github/app-manifest";
import {
  getAuthenticatedUser,
  GitHubApiError,
} from "@/lib/github/client";

type ManifestConversion = {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
};

type GitHubAppUserToken = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

export class GitHubAppConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAppConfigurationError";
  }
}

function expiresAt(seconds: number | undefined): Date | null {
  return seconds ? new Date(Date.now() + seconds * 1000) : null;
}

async function exchangeUserToken(
  parameters: Record<string, string>,
): Promise<GitHubAppUserToken & { access_token: string }> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RepoMonitor",
    },
    body: new URLSearchParams(parameters),
  });
  const body = (await response.json()) as GitHubAppUserToken;
  if (!response.ok || !body.access_token || body.error) {
    throw new GitHubAppConfigurationError(
      body.error_description ??
        body.error ??
        "GitHub App authorization could not be completed.",
    );
  }
  return body as GitHubAppUserToken & { access_token: string };
}

export function githubAppManifest() {
  return createGitHubAppManifest(config().APP_URL);
}

const existingAppSchema = z.object({
  appId: z.string().trim().regex(/^[1-9]\d*$/).max(20),
  slug: z.string().trim().regex(/^[a-z0-9_-]+$/i).max(100),
  clientId: z.string().trim().regex(/^[a-z0-9_.-]+$/i).max(255),
  clientSecret: z.string().trim().min(1).max(512).regex(/^\S+$/),
});

export async function connectExistingGitHubApp(
  credentials: unknown,
  configuredByUserId: string,
) {
  if (!isProduction()) {
    throw new GitHubAppConfigurationError(
      "GitHub App connection is disabled in development.",
    );
  }
  const parsed = existingAppSchema.safeParse(credentials);
  if (!parsed.success) {
    throw new GitHubAppConfigurationError(
      "Enter a numeric App ID, an app slug (not a URL), a Client ID, and a client secret from your GitHub App settings.",
    );
  }
  return saveGitHubAppConfiguration(parsed.data, configuredByUserId);
}

export async function registerGitHubAppFromManifest(
  code: string,
  configuredByUserId: string,
) {
  if (!isProduction()) {
    throw new GitHubAppConfigurationError(
      "GitHub App registration is disabled in development.",
    );
  }

  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "RepoMonitor",
      },
    },
  );
  const body = (await response.json()) as ManifestConversion & {
    message?: string;
  };
  if (
    !response.ok ||
    !body.id ||
    !body.slug ||
    !body.client_id ||
    !body.client_secret
  ) {
    throw new GitHubAppConfigurationError(
      body.message ?? "GitHub App registration could not be completed.",
    );
  }

  return saveGitHubAppConfiguration(
    {
      appId: String(body.id),
      slug: body.slug,
      clientId: body.client_id,
      clientSecret: body.client_secret,
    },
    configuredByUserId,
  );
}

async function saveGitHubAppConfiguration(
  credentials: z.infer<typeof existingAppSchema>,
  configuredByUserId: string,
) {
  const configuration = {
    appId: credentials.appId,
    slug: credentials.slug,
    clientId: credentials.clientId,
    clientSecretEncrypted: encryptSecret(credentials.clientSecret),
    configuredByUserId,
  };
  return db.gitHubAppConfiguration.upsert({
    where: { id: "global" },
    update: {
      ...configuration,
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      refreshTokenEncrypted: null,
      refreshTokenExpiresAt: null,
      authorizedByUserId: null,
      authorizedGithubLogin: null,
      authorizedAt: null,
    },
    create: {
      id: "global",
      ...configuration,
    },
  });
}

export async function authorizeGitHubAppForPublicPolling(
  code: string,
  codeVerifier: string,
  expectedGithubId: string,
  authorizedByUserId: string,
): Promise<string> {
  if (!isProduction()) {
    throw new GitHubAppConfigurationError(
      "GitHub App authorization is disabled in development.",
    );
  }

  const app = await db.gitHubAppConfiguration.findUnique({
    where: { id: "global" },
  });
  if (!app) {
    throw new GitHubAppConfigurationError("Register the GitHub App first.");
  }

  const token = await exchangeUserToken({
    client_id: app.clientId,
    client_secret: decryptSecret(app.clientSecretEncrypted),
    code,
    code_verifier: codeVerifier,
    redirect_uri: `${config().APP_URL}/api/admin/github-app/authorize/callback`,
  });
  const githubUser = await getAuthenticatedUser(token.access_token);
  if (String(githubUser.id) !== expectedGithubId) {
    throw new GitHubAppConfigurationError(
      "Authorize the GitHub App with the same super-admin GitHub account that is signed in to RepoMonitor.",
    );
  }

  const now = new Date();
  const saved = await db.gitHubAppConfiguration.updateMany({
    where: {
      id: app.id,
      clientId: app.clientId,
      clientSecretEncrypted: app.clientSecretEncrypted,
      accessTokenEncrypted: app.accessTokenEncrypted,
      updatedAt: app.updatedAt,
    },
    data: {
      accessTokenEncrypted: encryptSecret(token.access_token),
      accessTokenExpiresAt: expiresAt(token.expires_in),
      refreshTokenEncrypted: token.refresh_token
        ? encryptSecret(token.refresh_token)
        : null,
      refreshTokenExpiresAt: expiresAt(token.refresh_token_expires_in),
      authorizedByUserId,
      authorizedGithubLogin: githubUser.login,
      authorizedAt: now,
    },
  });
  if (saved.count === 0) {
    throw new GitHubAppConfigurationError(
      "The GitHub App connection changed during authorization. Please authorize the current app again.",
    );
  }
  return githubUser.login;
}

/**
 * The shared app refresh token is single-use, so overlapping poll runs must not
 * exchange it concurrently; the loser would fail with an already-rotated token.
 */
const inFlightRefreshes = new Map<string, Promise<string>>();

async function publicPollingToken(rejectedToken?: string): Promise<string> {
  const app = await db.gitHubAppConfiguration.findUnique({
    where: { id: "global" },
  });
  if (!app?.accessTokenEncrypted) {
    throw new GitHubAppConfigurationError(
      "The public-polling GitHub App has not been authorized by a super admin.",
    );
  }

  // Read the current token on every request. A failed request may have used an
  // older token from before a refresh, reauthorization, or app replacement.
  const token = decryptSecret(app.accessTokenEncrypted);
  const expiring = app.accessTokenExpiresAt !== null &&
    app.accessTokenExpiresAt.getTime() <= Date.now() + 5 * 60 * 1000;
  if (!expiring && token !== rejectedToken) return token;

  if (
    !app.refreshTokenEncrypted ||
    (app.refreshTokenExpiresAt && app.refreshTokenExpiresAt.getTime() <= Date.now())
  ) {
    // Let the 401 handler verify a rejected token before invalidating it.
    if (rejectedToken === token) return token;
    throw new GitHubAppConfigurationError(
      "The public-polling GitHub App authorization expired. A super admin must authorize it again.",
    );
  }

  const key = `${app.clientId}:${app.updatedAt.getTime()}:${app.accessTokenEncrypted}:${app.refreshTokenEncrypted}`;
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;
  const pending = refreshPublicPollingToken(app).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, pending);
  return pending;
}

async function refreshPublicPollingToken(app: GitHubAppConfiguration): Promise<string> {
  let refreshed: GitHubAppUserToken & { access_token: string };
  try {
    refreshed = await exchangeUserToken({
      client_id: app.clientId,
      client_secret: decryptSecret(app.clientSecretEncrypted),
      grant_type: "refresh_token",
      refresh_token: decryptSecret(app.refreshTokenEncrypted!),
    });
  } catch {
    // Keep the saved authorization on network/provider failures. Another
    // request may also have already rotated this refresh token.
    const current = await db.gitHubAppConfiguration.findUnique({
      where: { id: app.id },
    });
    if (current?.accessTokenEncrypted !== app.accessTokenEncrypted) {
      return publicPollingToken();
    }
    throw new GitHubAppConfigurationError(
      "The public-polling GitHub App token could not be refreshed. Retry, or ask a super admin to reauthorize the existing app in Settings if this persists.",
    );
  }

  const saved = await db.gitHubAppConfiguration.updateMany({
    where: {
      id: app.id,
      clientId: app.clientId,
      clientSecretEncrypted: app.clientSecretEncrypted,
      accessTokenEncrypted: app.accessTokenEncrypted,
      refreshTokenEncrypted: app.refreshTokenEncrypted,
      updatedAt: app.updatedAt,
    },
    data: {
      accessTokenEncrypted: encryptSecret(refreshed.access_token),
      accessTokenExpiresAt: expiresAt(refreshed.expires_in),
      refreshTokenEncrypted: refreshed.refresh_token
        ? encryptSecret(refreshed.refresh_token)
        : app.refreshTokenEncrypted,
      refreshTokenExpiresAt: refreshed.refresh_token
        ? expiresAt(refreshed.refresh_token_expires_in)
        : app.refreshTokenExpiresAt,
    },
  });
  return saved.count > 0 ? refreshed.access_token : publicPollingToken();
}

async function clearInvalidAuthorization(rejectedToken: string): Promise<boolean> {
  const app = await db.gitHubAppConfiguration.findUnique({
    where: { id: "global" },
  });
  if (!app?.accessTokenEncrypted || decryptSecret(app.accessTokenEncrypted) !== rejectedToken) {
    return false;
  }
  const cleared = await db.gitHubAppConfiguration.updateMany({
    where: {
      id: app.id,
      accessTokenEncrypted: app.accessTokenEncrypted,
      updatedAt: app.updatedAt,
    },
    data: {
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      refreshTokenEncrypted: null,
      refreshTokenExpiresAt: null,
      authorizedByUserId: null,
      authorizedGithubLogin: null,
      authorizedAt: null,
    },
  });
  return cleared.count > 0;
}

export async function withPublicRepositoryToken<T>(
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  if (!isProduction()) {
    return operation("");
  }

  let token = await publicPollingToken();
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(token);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 401) throw error;
      console.warn("Public repository request rejected by GitHub", {
        status: error.status,
        path: error.requestPath,
        requestId: error.requestId,
      });

      if (attempt === 0) {
        const recovered = await publicPollingToken(token);
        if (recovered !== token) {
          token = recovered;
          continue;
        }
      }

      // A repository failure alone does not prove the user's authorization was
      // revoked. Only clear the rejected token if GitHub also rejects /user.
      try {
        await getAuthenticatedUser(token);
      } catch (validationError) {
        if (!(validationError instanceof GitHubApiError) || validationError.status !== 401) {
          throw new GitHubAppConfigurationError(
            "GitHub could not verify the public-polling token. The saved authorization has been kept; please try again.",
          );
        }
        const cleared = await clearInvalidAuthorization(token);
        throw new GitHubAppConfigurationError(
          cleared
            ? "GitHub rejected the public-polling token and it could not be recovered. A super admin must reauthorize the existing app in Settings; recreating it is not required."
            : "The GitHub App authorization changed while the request was running. Please try again.",
        );
      }
      throw new GitHubAppConfigurationError(
        "GitHub rejected the repository request (HTTP 401), but the public-polling app authorization is still valid. Please retry; recreating the app is not required.",
      );
    }
  }
}

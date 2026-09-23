import "server-only";

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

let cachedPublicToken:
  | {
      configurationUpdatedAt: number;
      token: string;
      expiresAt: number | null;
    }
  | undefined;

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
  cachedPublicToken = undefined;
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
  cachedPublicToken = undefined;
  await db.gitHubAppConfiguration.update({
    where: { id: app.id },
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
  return githubUser.login;
}

/**
 * The shared app refresh token is single-use, so overlapping poll runs must not
 * exchange it concurrently; the loser would fail with an already-rotated token.
 */
let inFlightPublicToken: Promise<string> | undefined;

function publicPollingToken(): Promise<string> {
  if (inFlightPublicToken) return inFlightPublicToken;
  const pending = loadPublicPollingToken().finally(() => {
    inFlightPublicToken = undefined;
  });
  inFlightPublicToken = pending;
  return pending;
}

async function loadPublicPollingToken(): Promise<string> {
  let app = await db.gitHubAppConfiguration.findUnique({
    where: { id: "global" },
  });
  if (!app?.accessTokenEncrypted) {
    throw new GitHubAppConfigurationError(
      "The public-polling GitHub App has not been authorized by a super admin.",
    );
  }

  const tokenExpiresAt = app.accessTokenExpiresAt?.getTime() ?? null;
  if (
    cachedPublicToken &&
    cachedPublicToken.configurationUpdatedAt === app.updatedAt.getTime() &&
    cachedPublicToken.expiresAt === tokenExpiresAt &&
    (cachedPublicToken.expiresAt === null ||
      cachedPublicToken.expiresAt > Date.now() + 5 * 60 * 1000)
  ) {
    return cachedPublicToken.token;
  }

  if (tokenExpiresAt !== null && tokenExpiresAt <= Date.now() + 5 * 60 * 1000) {
    if (
      !app.refreshTokenEncrypted ||
      (app.refreshTokenExpiresAt &&
        app.refreshTokenExpiresAt.getTime() <= Date.now())
    ) {
      throw new GitHubAppConfigurationError(
        "The public-polling GitHub App authorization expired. A super admin must authorize it again.",
      );
    }

    const refreshed = await exchangeUserToken({
      client_id: app.clientId,
      client_secret: decryptSecret(app.clientSecretEncrypted),
      grant_type: "refresh_token",
      refresh_token: decryptSecret(app.refreshTokenEncrypted),
    });
    app = await db.gitHubAppConfiguration.update({
      where: { id: app.id },
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
  }

  if (!app.accessTokenEncrypted) {
    throw new GitHubAppConfigurationError(
      "The public-polling GitHub App has not been authorized by a super admin.",
    );
  }
  const token = decryptSecret(app.accessTokenEncrypted);
  cachedPublicToken = {
    configurationUpdatedAt: app.updatedAt.getTime(),
    token,
    expiresAt: app.accessTokenExpiresAt?.getTime() ?? null,
  };
  return token;
}

async function clearInvalidAuthorization(): Promise<void> {
  cachedPublicToken = undefined;
  await db.gitHubAppConfiguration.updateMany({
    where: { id: "global" },
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
}

export async function withPublicRepositoryToken<T>(
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  if (!isProduction()) {
    return operation("");
  }

  const token = await publicPollingToken();
  try {
    return await operation(token);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 401) {
      await clearInvalidAuthorization();
      throw new GitHubAppConfigurationError(
        "The public-polling GitHub App authorization was revoked. A super admin must authorize it again.",
      );
    }
    throw error;
  }
}

import type { GitHubAppConfiguration } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  isProduction: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  config: () => ({
    APP_URL: "https://monitor.example",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  }),
  isProduction: mocks.isProduction,
}));
vi.mock("@/lib/db", () => ({
  db: { gitHubAppConfiguration: {
    findUnique: mocks.findUnique,
    updateMany: mocks.updateMany,
  } },
}));
vi.mock("@/lib/github/client", async () => ({
  GitHubApiError: (await import("@/lib/github/access")).GitHubApiError,
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { GitHubApiError } from "@/lib/github/access";
import {
  authorizeGitHubAppForPublicPolling,
  withPublicRepositoryToken,
} from "@/lib/github/app";

let stored: GitHubAppConfiguration;
let fetchMock: ReturnType<typeof vi.fn>;

function rejected() {
  return new GitHubApiError(
    "GitHub request failed with 401", 401, '{"message":"Bad credentials"}',
    null, null, "/repos/example/repo", "test-request-id",
  );
}

function replaceAuthorization(token: string) {
  stored = {
    ...stored,
    accessTokenEncrypted: encryptSecret(token),
    updatedAt: new Date(stored.updatedAt.getTime() + 1),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.isProduction.mockReturnValue(true);
  stored = {
    id: "global", appId: "123", slug: "public-poller", clientId: "Iv23.example",
    clientSecretEncrypted: encryptSecret("app-secret"),
    accessTokenEncrypted: encryptSecret("original-token"),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenEncrypted: encryptSecret("refresh-token"),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    configuredByUserId: "admin", authorizedByUserId: "admin",
    authorizedGithubLogin: "octocat", authorizedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
  };
  mocks.findUnique.mockImplementation(async () => ({ ...stored }));
  mocks.updateMany.mockImplementation(async ({ where, data }) => {
    const matches = Object.entries(where).every(([key, value]) => {
      const current = stored[key as keyof GitHubAppConfiguration];
      return current instanceof Date && value instanceof Date
        ? current.getTime() === value.getTime() : current === value;
    });
    if (!matches) return { count: 0 };
    stored = { ...stored, ...data, updatedAt: new Date(stored.updatedAt.getTime() + 1) };
    return { count: 1 };
  });
  mocks.getAuthenticatedUser.mockResolvedValue({ id: 42, login: "octocat" });
  fetchMock = vi.fn().mockImplementation(async () => Response.json({
    access_token: "refreshed-token", expires_in: 28_800,
    refresh_token: "rotated-refresh-token", refresh_token_expires_in: 15_897_600,
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public GitHub App token recovery", () => {
  it("refreshes a rejected token and retries once even before its recorded expiry", async () => {
    const operation = vi.fn().mockRejectedValueOnce(rejected()).mockResolvedValue("repository");
    await expect(withPublicRepositoryToken(operation)).resolves.toBe("repository");
    expect(operation.mock.calls).toEqual([["original-token"], ["refreshed-token"]]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(Object.fromEntries(options.body)).toEqual({
      client_id: stored.clientId, client_secret: "app-secret",
      grant_type: "refresh_token", refresh_token: "refresh-token",
    });
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("refreshed-token");
    expect(decryptSecret(stored.refreshTokenEncrypted!)).toBe("rotated-refresh-token");
    expect(stored.authorizedGithubLogin).toBe("octocat");
    expect(mocks.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), {
      status: 401, path: "/repos/example/repo", requestId: "test-request-id",
    });
  });

  it("uses a newer authorization when an old request fails without refreshing or clearing it", async () => {
    const operation = vi.fn().mockImplementationOnce(async () => {
      replaceAuthorization("new-authorization");
      throw rejected();
    }).mockResolvedValue("repository");
    await expect(withPublicRepositoryToken(operation)).resolves.toBe("repository");
    expect(operation.mock.calls).toEqual([["original-token"], ["new-authorization"]]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("shares one rotating refresh exchange between simultaneous rejected requests", async () => {
    const operation = vi.fn().mockImplementation(async (token) => {
      if (token === "original-token") throw rejected();
      return token;
    });
    await expect(Promise.all([
      withPublicRepositoryToken(operation), withPublicRepositoryToken(operation),
    ])).resolves.toEqual(["refreshed-token", "refreshed-token"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves valid authorization when a repository still returns 401", async () => {
    const operation = vi.fn().mockRejectedValue(rejected());
    await expect(withPublicRepositoryToken(operation)).rejects.toThrow("authorization is still valid");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.getAuthenticatedUser).toHaveBeenCalledWith("refreshed-token");
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("refreshed-token");
  });

  it("clears the rejected authorization only after the identity check also fails", async () => {
    mocks.getAuthenticatedUser.mockRejectedValue(rejected());
    await expect(withPublicRepositoryToken(vi.fn().mockRejectedValue(rejected())))
      .rejects.toThrow("reauthorize the existing app");
    expect(stored.accessTokenEncrypted).toBeNull();
    expect(stored.refreshTokenEncrypted).toBeNull();
    expect(stored.authorizedAt).toBeNull();
    expect(stored.clientId).toBe("Iv23.example");
  });

  it("verifies a token without a refresh token before clearing it", async () => {
    stored.refreshTokenEncrypted = null;
    await expect(withPublicRepositoryToken(vi.fn().mockRejectedValue(rejected())))
      .rejects.toThrow("authorization is still valid");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedUser).toHaveBeenCalledWith("original-token");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not clear a reauthorization completed during the identity check", async () => {
    stored.refreshTokenEncrypted = null;
    mocks.getAuthenticatedUser.mockImplementation(async () => {
      replaceAuthorization("new-authorization");
      throw rejected();
    });
    await expect(withPublicRepositoryToken(vi.fn().mockRejectedValue(rejected())))
      .rejects.toThrow("authorization changed");
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("new-authorization");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("guards against reauthorization between the invalidation read and write", async () => {
    stored.refreshTokenEncrypted = null;
    mocks.getAuthenticatedUser.mockRejectedValue(rejected());
    const update = mocks.updateMany.getMockImplementation()!;
    mocks.updateMany.mockImplementationOnce(async (args) => {
      replaceAuthorization("new-authorization");
      return update(args);
    });
    await expect(withPublicRepositoryToken(vi.fn().mockRejectedValue(rejected())))
      .rejects.toThrow("authorization changed");
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("new-authorization");
  });

  it("does not overwrite an app replacement with an in-flight refresh result", async () => {
    fetchMock.mockImplementation(async () => {
      replaceAuthorization("replacement-token");
      stored.clientId = "Iv23.replacement";
      return Response.json({ access_token: "stale-refresh-result", expires_in: 28_800 });
    });
    const operation = vi.fn().mockRejectedValueOnce(rejected()).mockResolvedValue("repository");
    await expect(withPublicRepositoryToken(operation)).resolves.toBe("repository");
    expect(operation.mock.calls[1]).toEqual(["replacement-token"]);
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("replacement-token");
  });

  it("keeps credentials when a refresh request fails temporarily", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "server_error" }, { status: 502 }));
    await expect(withPublicRepositoryToken(vi.fn().mockRejectedValue(rejected())))
      .rejects.toThrow("could not be refreshed");
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("original-token");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("uses a concurrently refreshed token if its own refresh exchange fails", async () => {
    fetchMock.mockImplementation(async () => {
      replaceAuthorization("other-request-token");
      return Response.json({ error: "bad_refresh_token" });
    });
    const operation = vi.fn().mockRejectedValueOnce(rejected()).mockResolvedValue("repository");
    await expect(withPublicRepositoryToken(operation)).resolves.toBe("repository");
    expect(operation.mock.calls[1]).toEqual(["other-request-token"]);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it.each([403, 429, 503])("keeps credentials when the identity check returns %s", async (status) => {
    stored.refreshTokenEncrypted = null;
    const unavailable = new GitHubApiError("Unavailable", status, "{}");
    mocks.getAuthenticatedUser.mockRejectedValue(unavailable);
    await expect(withPublicRepositoryToken(vi.fn().mockRejectedValue(rejected())))
      .rejects.toThrow("saved authorization has been kept");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("still refreshes expiring tokens before using them", async () => {
    stored.accessTokenExpiresAt = new Date(Date.now() + 60_000);
    const operation = vi.fn().mockResolvedValue("repository");
    await expect(withPublicRepositoryToken(operation)).resolves.toBe("repository");
    expect(operation).toHaveBeenCalledWith("refreshed-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat a repository permission error as token revocation", async () => {
    const denied = new GitHubApiError("Forbidden", 403, "{}");
    await expect(withPublicRepositoryToken(vi.fn().mockRejectedValue(denied))).rejects.toBe(denied);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("GitHub App authorization", () => {
  it("saves verified user credentials for the current app", async () => {
    await expect(authorizeGitHubAppForPublicPolling("code", "verifier", "42", "admin"))
      .resolves.toBe("octocat");
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("refreshed-token");
  });

  it("does not save an old callback's tokens over a replaced connection", async () => {
    mocks.getAuthenticatedUser.mockImplementation(async () => {
      stored.clientId = "Iv23.replacement";
      replaceAuthorization("replacement-token");
      return { id: 42, login: "octocat" };
    });
    await expect(authorizeGitHubAppForPublicPolling("code", "verifier", "42", "admin"))
      .rejects.toThrow("connection changed");
    expect(decryptSecret(stored.accessTokenEncrypted!)).toBe("replacement-token");
  });
});

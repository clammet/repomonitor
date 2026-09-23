import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_URL = "https://repomonitor.example.com";
const credentials = {
  appId: "123456",
  slug: "repomonitor-public-poller",
  clientId: "Iv23.example",
  clientSecret: "test-client-secret",
};

const mocks = vi.hoisted(() => ({
  requireRouteAdmin: vi.fn(),
  isProduction: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({
  requireRouteAdmin: mocks.requireRouteAdmin,
}));
vi.mock("@/lib/config", () => ({
  config: () => ({
    APP_URL,
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  }),
  isProduction: mocks.isProduction,
}));
vi.mock("@/lib/db", () => ({
  db: { gitHubAppConfiguration: { upsert: mocks.upsert } },
}));

import { POST } from "@/app/api/admin/github-app/connect/route";
import { decryptSecret } from "@/lib/crypto";
import { registerGitHubAppFromManifest } from "@/lib/github/app";
import { HttpError } from "@/lib/http";

function request(
  values: Record<string, string> = credentials,
  origin: string | null = APP_URL,
): Request {
  return new Request(`${APP_URL}/api/admin/github-app/connect`, {
    method: "POST",
    headers: origin ? { origin } : {},
    body: new URLSearchParams(values),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireRouteAdmin.mockResolvedValue({ id: "admin-1" });
  mocks.isProduction.mockReturnValue(true);
  mocks.upsert.mockResolvedValue({ id: "global" });
});

afterEach(() => vi.unstubAllGlobals());

describe("connect an existing GitHub App", () => {
  it("normalizes credentials, encrypts the secret, and requires fresh authorization", async () => {
    const response = await POST(
      request(Object.fromEntries(
        Object.entries(credentials).map(([key, value]) => [key, ` ${value} `]),
      )),
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_URL);
    expect(location.pathname).toBe("/settings");
    expect(location.searchParams.has("notice")).toBe(true);
    expect(location.href).not.toContain(credentials.clientSecret);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const { where, create, update } = mocks.upsert.mock.calls[0][0];
    expect(where).toEqual({ id: "global" });
    expect(create).toEqual({
      id: "global",
      appId: credentials.appId,
      slug: credentials.slug,
      clientId: credentials.clientId,
      clientSecretEncrypted: expect.any(String),
      configuredByUserId: "admin-1",
    });
    expect(create.clientSecretEncrypted).not.toContain(credentials.clientSecret);
    expect(decryptSecret(create.clientSecretEncrypted)).toBe(credentials.clientSecret);
    expect(update).toEqual({
      appId: credentials.appId,
      slug: credentials.slug,
      clientId: credentials.clientId,
      clientSecretEncrypted: create.clientSecretEncrypted,
      configuredByUserId: "admin-1",
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      refreshTokenEncrypted: null,
      refreshTokenExpiresAt: null,
      authorizedByUserId: null,
      authorizedGithubLogin: null,
      authorizedAt: null,
    });
  });

  it.each([
    ["appId", "1e3"],
    ["appId", "0"],
    ["slug", "https://github.com/apps/example"],
    ["slug", "../example"],
    ["clientId", "invalid client"],
    ["clientSecret", "   "],
    ["clientSecret", "x".repeat(513)],
  ])("rejects invalid %s without changing the connection", async (field, value) => {
    const response = await POST(request({ ...credentials, [field]: value }));

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(true);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects missing credentials", async () => {
    await POST(request({}));
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a file in place of a credential", async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(credentials)) form.set(key, value);
    form.set("clientSecret", new Blob(["file content"]), "secret.txt");
    const response = await POST(new Request(`${APP_URL}/api/admin/github-app/connect`, {
      method: "POST",
      headers: { origin: APP_URL },
      body: form,
    }));

    expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(true);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([null, "https://other.example"])("rejects origin %s", async (origin) => {
    const response = await POST(request(credentials, origin));
    expect(response.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([401, 403])("honors the admin guard's %s response", async (status) => {
    mocks.requireRouteAdmin.mockRejectedValue(new HttpError(status, "Access denied"));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not connect apps in development", async () => {
    mocks.isProduction.mockReturnValue(false);
    const response = await POST(request());
    expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(true);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not expose storage error details in the redirect", async () => {
    mocks.upsert.mockRejectedValue(new Error(`Storage error: ${credentials.clientSecret}`));
    const response = await POST(request());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).not.toContain(credentials.clientSecret);
    expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(true);
  });

  it("still saves credentials returned by new-app manifest registration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      id: 123456,
      slug: credentials.slug,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    })));

    await registerGitHubAppFromManifest("manifest-code", "admin-1");
    const { create, update } = mocks.upsert.mock.calls[0][0];
    expect(create.appId).toBe("123456");
    expect(create.clientId).toBe(credentials.clientId);
    expect(decryptSecret(create.clientSecretEncrypted)).toBe(credentials.clientSecret);
    expect(update.accessTokenEncrypted).toBeNull();
  });
});

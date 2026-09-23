import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  GitHubApiError,
  getCommit,
  githubFetch,
  listCommitsBetween,
  listReleasesAfter,
} from "@/lib/github/client";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "X-RateLimit-Limit": "5000",
      "X-RateLimit-Remaining": "4999",
      "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1_000) + 3_600),
    },
  });
}

function release(id: number, draft = false) {
  return {
    id,
    tag_name: `v${id}`,
    target_commitish: "main",
    name: `Release ${id}`,
    body: null,
    html_url: `https://github.com/o/r/releases/${id}`,
    draft,
    prerelease: false,
    published_at: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub request authentication", () => {
  it("retains the failed endpoint and GitHub request ID without query values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: "Bad credentials" }),
      { status: 401, headers: { "x-github-request-id": "request-123" } },
    )));

    const failure = await githubFetch("secret-token", "/repos/o/r?ref=private-value")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubApiError);
    expect(failure).toMatchObject({
      status: 401, requestPath: "/repos/o/r", requestId: "request-123",
    });
    expect(JSON.stringify(failure)).not.toContain("secret-token");
    expect(JSON.stringify(failure)).not.toContain("private-value");
  });

  it("omits authorization for anonymous public polling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "59",
          "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1_000) + 3_600),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await githubFetch("", "/repos/openai/openai-node");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("sends bearer authorization when a token is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1_000) + 3_600),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await githubFetch("secret-token", "/user");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });
});

describe("release scanning", () => {
  it("reports new releases when the tracked release is still present", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([release(30), release(20), release(10)]),
        ),
    );

    const scan = await listReleasesAfter("token", "o", "r", "10");

    expect(scan.cursorFound).toBe(true);
    expect(scan.releases.map((item) => item.id)).toEqual([20, 30]);
  });

  it("flags a deleted cursor release instead of returning the whole history", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([release(30), release(20), release(10)]),
        ),
    );

    // Release 15 was deleted, so nothing here can be proven new.
    const scan = await listReleasesAfter("token", "o", "r", "15");

    expect(scan.cursorFound).toBe(false);
  });

  it("treats a repository that had no releases as fully new", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([release(2), release(1)])),
    );

    const scan = await listReleasesAfter("token", "o", "r", "none");

    expect(scan.cursorFound).toBe(true);
    expect(scan.releases.map((item) => item.id)).toEqual([1, 2]);
  });

  it("skips drafts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([release(30, true), release(20), release(10)]),
        ),
    );

    const scan = await listReleasesAfter("token", "o", "r", "10");

    expect(scan.releases.map((item) => item.id)).toEqual([20]);
  });
});

describe("commit scanning", () => {
  it("returns compare results oldest first and reports truncation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          total_commits: 5,
          commits: [{ sha: "aaa" }, { sha: "bbb" }],
          files: [],
        }),
      ),
    );

    const scan = await listCommitsBetween("token", "o", "r", "base", "head", 1);

    expect(scan.commits.map((commit) => commit.sha)).toEqual(["aaa", "bbb"]);
    expect(scan.truncated).toBe(true);
  });

  it("is not truncated when every commit was returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          total_commits: 2,
          commits: [{ sha: "aaa" }, { sha: "bbb" }],
        }),
      ),
    );

    const scan = await listCommitsBetween("token", "o", "r", "base", "head");

    expect(scan.truncated).toBe(false);
  });
});

describe("commit file pagination", () => {
  it("collects files beyond the first page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `file-${index}.ts`,
      status: "modified",
    }));
    const secondPage = [{ filename: "file-100.ts", status: "modified" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sha: "aaa", files: firstPage }))
      .mockResolvedValueOnce(jsonResponse({ sha: "aaa", files: secondPage }));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await getCommit("token", "o", "r", "aaa");

    expect(detail.files).toHaveLength(101);
    expect(detail.files?.at(-1)?.filename).toBe("file-100.ts");
  });

  it("stops when a page repeats the files already seen", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      filename: `file-${index}.ts`,
      status: "modified",
    }));
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ sha: "aaa", files: page }));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await getCommit("token", "o", "r", "aaa");

    expect(detail.files).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

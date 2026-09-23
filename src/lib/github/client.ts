import "server-only";

import { createHash } from "node:crypto";

import {
  GitHubApiError,
  permanentGitHubAccessFailure,
} from "@/lib/github/access";
import {
  GITHUB_DEFAULT_HOURLY_LIMIT,
  GitHubRateLimitTracker,
  type GitHubRequestMode,
} from "@/lib/github/rate-limit";

const API_ROOT = "https://api.github.com";

export { GitHubApiError, permanentGitHubAccessFailure };

type GitHubRequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

const rateLimits = new GitHubRateLimitTracker();

function requestIdentity(accessToken: string): {
  key: string;
  mode: GitHubRequestMode;
} {
  if (!accessToken) return { key: "anonymous", mode: "anonymous" };
  const fingerprint = createHash("sha256")
    .update(accessToken)
    .digest("base64url");
  return { key: `token:${fingerprint}`, mode: "authenticated" };
}

export async function githubFetch<T>(
  accessToken: string,
  path: string,
  options: GitHubRequestOptions = {},
): Promise<T> {
  const identity = requestIdentity(accessToken);
  const blocked = rateLimits.reserve(identity.key, identity.mode);
  if (blocked) {
    throw new GitHubApiError(
      `GitHub ${identity.mode} REST API limit is exhausted; retry after ${blocked.retryAfterSeconds} seconds`,
      429,
      JSON.stringify({
        message: `${identity.mode} GitHub REST API request budget exhausted`,
        limit: GITHUB_DEFAULT_HOURLY_LIMIT[identity.mode],
      }),
      String(blocked.retryAfterSeconds),
      String(blocked.remaining),
    );
  }

  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "RepoMonitor",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
  });
  const errorBody = response.ok ? "" : await response.text();
  rateLimits.recordResponse(
    identity.key,
    identity.mode,
    {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset"),
      retryAfter: response.headers.get("retry-after"),
    },
    response.status,
    errorBody,
  );

  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub request failed with ${response.status}`,
      response.status,
      errorBody,
      response.headers.get("retry-after"),
      response.headers.get("x-ratelimit-remaining"),
      path.split("?")[0],
      response.headers.get("x-github-request-id"),
    );
  }
  return (await response.json()) as T;
}

export type GitHubUser = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
};

export type GitHubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  owner: { login: string };
};

export type GitHubCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string } | null;
};

export type GitHubCommitDetail = GitHubCommit & {
  files?: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    patch?: string;
  }>;
};

export type GitHubRelease = {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
};

type GitHubContents = {
  type: "file";
  encoding: "base64" | string;
  content: string;
};

export async function getAuthenticatedUser(accessToken: string) {
  return githubFetch<GitHubUser>(accessToken, "/user");
}

export async function getAuthenticatedEmails(accessToken: string) {
  return githubFetch<GitHubEmail[]>(accessToken, "/user/emails");
}

export async function getRepository(
  accessToken: string,
  owner: string,
  name: string,
) {
  return githubFetch<GitHubRepository>(
    accessToken,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
}

/**
 * A commit response carries at most 300 files; the remainder is only reachable
 * through pagination, so keep requesting while new filenames appear.
 */
export async function getCommit(
  accessToken: string,
  owner: string,
  name: string,
  ref: string,
  maxFilePages = 10,
): Promise<GitHubCommitDetail> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}`;
  const detail = await githubFetch<GitHubCommitDetail>(
    accessToken,
    `${base}?per_page=100&page=1`,
  );
  if (!detail.files || detail.files.length < 100) return detail;

  const files = [...detail.files];
  const seen = new Set(files.map((file) => file.filename));
  for (let page = 2; page <= maxFilePages; page += 1) {
    const next = await githubFetch<GitHubCommitDetail>(
      accessToken,
      `${base}?per_page=100&page=${page}`,
    );
    const fresh = (next.files ?? []).filter((file) => !seen.has(file.filename));
    if (fresh.length === 0) break;
    for (const file of fresh) {
      seen.add(file.filename);
      files.push(file);
    }
    if ((next.files?.length ?? 0) < 100) break;
  }
  return { ...detail, files };
}

export type CommitScan = {
  commits: GitHubCommit[];
  /** True when the repository had more commits than this scan could return. */
  truncated: boolean;
};

/**
 * Lists commits reachable from `head` but not from `base`, oldest first. This
 * follows the commit graph rather than commit timestamps, so a fast-forward
 * push of older commits is still reported.
 */
export async function listCommitsBetween(
  accessToken: string,
  owner: string,
  name: string,
  base: string,
  head: string,
  maxPages = 10,
): Promise<CommitScan> {
  const commits: GitHubCommit[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const comparison = await githubFetch<
      GitHubComparison & { total_commits?: number }
    >(
      accessToken,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
    );
    total = comparison.total_commits ?? comparison.commits.length;
    if (comparison.commits.length === 0) break;
    commits.push(...comparison.commits);
    if (commits.length >= total) break;
  }
  return { commits, truncated: commits.length < total };
}

export async function listCommitsSince(
  accessToken: string,
  owner: string,
  name: string,
  branch: string,
  since: Date,
  maxPages = 10,
): Promise<CommitScan> {
  const commits: GitHubCommit[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({
      sha: branch,
      since: new Date(since.getTime() - 60_000).toISOString(),
      per_page: "100",
      page: String(page),
    });
    const batch = await githubFetch<GitHubCommit[]>(
      accessToken,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?${query}`,
    );
    commits.push(...batch);
    if (batch.length < 100) break;
    if (page === maxPages) truncated = true;
  }
  return { commits: commits.reverse(), truncated };
}

export type ReleaseScan = {
  releases: GitHubRelease[];
  /**
   * False when the tracked release could not be found — it was deleted, or the
   * history is longer than this scan. Replaying every release would flood
   * subscribers, so callers resynchronize instead.
   */
  cursorFound: boolean;
};

const NO_RELEASE_CURSOR = "none";

export async function listReleasesAfter(
  accessToken: string,
  owner: string,
  name: string,
  cursor: string,
  maxPages = 10,
): Promise<ReleaseScan> {
  const releases: GitHubRelease[] = [];
  // "none" means no release existed when monitoring started, so everything
  // found now is genuinely new.
  let reachedCursor = cursor === NO_RELEASE_CURSOR;
  let exhausted = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await githubFetch<GitHubRelease[]>(
      accessToken,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=100&page=${page}`,
    );
    let hitCursor = false;
    for (const release of batch) {
      if (String(release.id) === cursor) {
        hitCursor = true;
        break;
      }
      if (!release.draft) releases.push(release);
    }
    if (hitCursor) {
      reachedCursor = true;
      break;
    }
    if (batch.length < 100) {
      exhausted = true;
      break;
    }
  }
  if (cursor === NO_RELEASE_CURSOR && !exhausted) {
    // History was longer than the scan; treat it as a resynchronization.
    reachedCursor = false;
  }
  return { releases: releases.reverse(), cursorFound: reachedCursor };
}

export async function getLatestRelease(
  accessToken: string,
  owner: string,
  name: string,
): Promise<GitHubRelease | null> {
  const releases = await githubFetch<GitHubRelease[]>(
    accessToken,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=10`,
  );
  return releases.find((release) => !release.draft) ?? null;
}

export type GitHubComparison = {
  commits: GitHubCommit[];
  files?: GitHubCommitDetail["files"];
};

export async function compareCommits(
  accessToken: string,
  owner: string,
  name: string,
  base: string,
  head: string,
) {
  return githubFetch<GitHubComparison>(
    accessToken,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
}

export async function getFileContent(
  accessToken: string,
  owner: string,
  name: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const encodedPath = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  try {
    const query = new URLSearchParams({ ref });
    const file = await githubFetch<GitHubContents>(
      accessToken,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}?${query}`,
    );
    if (file.type !== "file" || file.encoding !== "base64") return null;
    return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString(
      "utf8",
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

export async function getFileLine(
  accessToken: string,
  owner: string,
  name: string,
  path: string,
  lineNumber: number,
  ref: string,
): Promise<string | null> {
  const content = await getFileContent(accessToken, owner, name, path, ref);
  return content?.split(/\r?\n/)[lineNumber - 1] ?? null;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
    readonly retryAfter: string | null = null,
    readonly rateLimitRemaining: string | null = null,
    readonly requestPath: string | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export type PermanentGitHubAccessFailure = {
  code: "REPOSITORY_UNAVAILABLE" | "ACCESS_DENIED" | "AUTHORIZATION_INVALID";
  message: string;
};

export function permanentGitHubAccessFailure(
  error: unknown,
): PermanentGitHubAccessFailure | null {
  if (!(error instanceof GitHubApiError)) return null;

  if (error.status === 404 || error.status === 410) {
    return {
      code: "REPOSITORY_UNAVAILABLE",
      message: "GitHub reports that this repository no longer exists or is unavailable.",
    };
  }
  if (error.status === 401) {
    return {
      code: "AUTHORIZATION_INVALID",
      message: "GitHub authorization is no longer valid for this repository.",
    };
  }
  if (error.status === 403) {
    const rateLimited =
      error.retryAfter !== null ||
      error.rateLimitRemaining === "0" ||
      /rate limit|secondary rate|abuse detection/i.test(error.responseBody);
    if (!rateLimited) {
      return {
        code: "ACCESS_DENIED",
        message: "GitHub denied access to this repository.",
      };
    }
  }
  return null;
}

export function githubScopes(scopes: string): Set<string> {
  return new Set(
    scopes
      .split(/[\s,]+/)
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function hasPrivateRepositoryAccess(scopes: string): boolean {
  return githubScopes(scopes).has("repo");
}

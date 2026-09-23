import { requireRouteAdmin } from "@/lib/auth/session";
import {
  connectExistingGitHubApp,
  GitHubAppConfigurationError,
} from "@/lib/github/app";
import { assertSameOrigin, redirectWithMessage, routeHandler } from "@/lib/http";

export const POST = routeHandler(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireRouteAdmin();
  const form = await request.formData();

  try {
    await connectExistingGitHubApp(
      {
        appId: form.get("appId"),
        slug: form.get("slug"),
        clientId: form.get("clientId"),
        clientSecret: form.get("clientSecret"),
      },
      user.id,
    );
    return redirectWithMessage(
      request,
      "/settings",
      "notice",
      "GitHub App credentials saved. Select Authorize GitHub App to verify them and enable public polling.",
    );
  } catch (error) {
    return redirectWithMessage(
      request,
      "/settings",
      "error",
      error instanceof GitHubAppConfigurationError
        ? error.message
        : "GitHub App credentials could not be saved. Please try again.",
    );
  }
});

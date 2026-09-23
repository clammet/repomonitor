import { ZodError } from "zod";

import { requireRouteUser } from "@/lib/auth/session";
import { assertSameOrigin, redirectWithMessage, routeHandler } from "@/lib/http";
import { updateCondition } from "@/lib/subscriptions";

type Context = { params: Promise<{ id: string; conditionId: string }> };

export const POST = routeHandler(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const user = await requireRouteUser();
  const { id, conditionId } = await context.params;
  const form = await request.formData();

  try {
    await updateCondition(user.id, id, conditionId, {
      note: String(form.get("note") ?? ""),
      textPattern: String(form.get("textPattern") ?? ""),
      filePath: String(form.get("filePath") ?? ""),
      lineNumber: String(form.get("lineNumber") ?? ""),
      notifyOnRemoved: String(form.get("notifyOnRemoved") ?? ""),
      notifyOnMoved: String(form.get("notifyOnMoved") ?? ""),
      notifyOnChanged: String(form.get("notifyOnChanged") ?? ""),
    });
    return redirectWithMessage(
      request,
      `/subscriptions/${id}`,
      "notice",
      "Condition updated",
    );
  } catch (error) {
    const message =
      error instanceof ZodError
        ? (error.issues[0]?.message ?? "Invalid condition")
        : error instanceof Error
          ? error.message
          : "Unable to update condition";
    return redirectWithMessage(request, `/subscriptions/${id}`, "error", message);
  }
});

import "server-only";

import {
  ConditionType,
  EventType,
  LineMatchState,
  type Condition,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { parseGitHubPermalink } from "@/lib/domain/github-permalink";
import {
  getCommit,
  getFileLine,
  getLatestRelease,
  getRepository,
} from "@/lib/github/client";
import { withPublicRepositoryToken } from "@/lib/github/app";
import {
  withPrivateRepositoryToken,
  withUserGitHubToken,
} from "@/lib/github/tokens";

const repoInputSchema = z
  .string()
  .trim()
  .min(3)
  .transform((input) => {
    const cleaned = input
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "");
    const [owner, name, ...rest] = cleaned.split("/");
    if (!owner || !name || rest.length) {
      throw new Error("Use owner/repository or a GitHub repository URL");
    }
    return { owner, name };
  });

const lineConditionSchema = z.object({
  filePath: z
    .string()
    .trim()
    .min(1, "A repository-relative file path is required")
    .refine((value) => !value.startsWith("/") && !value.includes(".."), {
      message: "Use a repository-relative file path",
    }),
  lineNumber: z.coerce.number().int().positive().max(1_000_000),
});

export function parseEventTypes(form: FormData): EventType[] {
  const result: EventType[] = [];
  if (form.get("commits") === "on") result.push(EventType.COMMIT);
  if (form.get("releases") === "on") result.push(EventType.RELEASE);
  return result;
}

async function withRepositoryReadToken<T>(
  userId: string,
  isPrivate: boolean,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  return isPrivate
    ? withPrivateRepositoryToken(userId, operation)
    : withPublicRepositoryToken(operation);
}

export async function createSubscription(
  userId: string,
  repositoryInput: string,
  eventTypes: EventType[],
): Promise<string> {
  if (eventTypes.length === 0) {
    throw new Error("Select commits, releases, or both");
  }
  const parsed = repoInputSchema.parse(repositoryInput);

  const discoveredRepo = await withUserGitHubToken(userId, (token) =>
    getRepository(token, parsed.owner, parsed.name),
  );
  return withRepositoryReadToken(
    userId,
    discoveredRepo.private,
    async (token) => {
    const githubRepo = await getRepository(
      token,
      discoveredRepo.owner.login,
      discoveredRepo.name,
    );
    if (githubRepo.private !== discoveredRepo.private) {
      throw new Error(
        "Repository visibility changed while the subscription was being created. Please try again.",
      );
    }
    const head = await getCommit(
      token,
      githubRepo.owner.login,
      githubRepo.name,
      githubRepo.default_branch,
    );
    const latestRelease = eventTypes.includes(EventType.RELEASE)
      ? await getLatestRelease(token, githubRepo.owner.login, githubRepo.name)
      : null;
    const latestReleaseCommit = latestRelease
      ? await getCommit(
          token,
          githubRepo.owner.login,
          githubRepo.name,
          latestRelease.tag_name,
        )
      : null;

    return db.$transaction(async (tx) => {
      const previousRepository = await tx.repository.findUnique({
        where: { fullName: githubRepo.full_name },
      });
      const visibilityChanged =
        previousRepository !== null &&
        previousRepository.isPrivate !== githubRepo.private;

      const repository = await tx.repository.upsert({
        where: { fullName: githubRepo.full_name },
        update: {
          owner: githubRepo.owner.login,
          name: githubRepo.name,
          githubId: String(githubRepo.id),
          defaultBranch: githubRepo.default_branch,
          isPrivate: githubRepo.private,
          htmlUrl: githubRepo.html_url,
        },
        create: {
          owner: githubRepo.owner.login,
          name: githubRepo.name,
          fullName: githubRepo.full_name,
          githubId: String(githubRepo.id),
          defaultBranch: githubRepo.default_branch,
          isPrivate: githubRepo.private,
          htmlUrl: githubRepo.html_url,
        },
      });

      // Flipping visibility moves polling between the shared repository cursor
      // and per-subscription cursors, which would silently strand everyone
      // already subscribed. Surface it to them instead.
      if (visibilityChanged) {
        const stranded = await tx.subscription.findMany({
          where: {
            repositoryId: repository.id,
            userId: { not: userId },
            enabled: true,
            errorAt: null,
          },
          select: { id: true },
        });
        const message = githubRepo.private
          ? "This repository is now private. Remove and add the subscription again so each account can authorize private polling."
          : "This repository is now public. Remove and add the subscription again to switch to shared GitHub App polling.";
        const errorAt = new Date();
        for (const item of stranded) {
          await tx.subscription.update({
            where: { id: item.id },
            data: { errorCode: "VISIBILITY_CHANGED", errorMessage: message, errorAt },
          });
          await tx.subscriptionErrorAlert.upsert({
            where: { subscriptionId: item.id },
            update: {
              errorCode: "VISIBILITY_CHANGED",
              message,
              status: "PENDING",
              attempts: 0,
              lastError: null,
              sentAt: null,
            },
            create: {
              subscriptionId: item.id,
              errorCode: "VISIBILITY_CHANGED",
              message,
            },
          });
        }
      }

      const previousSubscription = await tx.subscription.findUnique({
        where: { userId_repositoryId: { userId, repositoryId: repository.id } },
      });
      // A subscription that was switched off has a frozen cursor; resuming from
      // it would replay the entire backlog.
      const resumingAfterPause =
        previousSubscription !== null && !previousSubscription.enabled;

      const subscription = await tx.subscription.upsert({
        where: {
          userId_repositoryId: { userId, repositoryId: repository.id },
        },
        update: {
          enabled: true,
          errorCode: null,
          errorMessage: null,
          errorAt: null,
        },
        create: { userId, repositoryId: repository.id },
      });
      await tx.subscriptionErrorAlert.deleteMany({
        where: { subscriptionId: subscription.id },
      });

      for (const type of eventTypes) {
        await tx.subscriptionEvent.upsert({
          where: {
            subscriptionId_type: { subscriptionId: subscription.id, type },
          },
          update: { enabled: true },
          create: { subscriptionId: subscription.id, type },
        });

        const releaseCursor = latestRelease ? String(latestRelease.id) : "none";
        const freshCursor = {
          cursor: type === EventType.COMMIT ? head.sha : releaseCursor,
          lastCommitSha:
            type === EventType.COMMIT
              ? head.sha
              : (latestReleaseCommit?.sha ?? head.sha),
          lastSuccessfulAt: new Date(),
          lastError: null,
        };
        if (githubRepo.private) {
          await tx.subscriptionPollCursor.upsert({
            where: {
              subscriptionId_eventType: {
                subscriptionId: subscription.id,
                eventType: type,
              },
            },
            update: resumingAfterPause ? freshCursor : {},
            create: {
              subscriptionId: subscription.id,
              eventType: type,
              cursor: type === EventType.COMMIT ? head.sha : releaseCursor,
              lastCommitSha:
                type === EventType.COMMIT
                  ? head.sha
                  : (latestReleaseCommit?.sha ?? head.sha),
              lastSuccessfulAt: new Date(),
            },
          });
        } else {
          await tx.repoPollCursor.upsert({
            where: {
              repositoryId_eventType: {
                repositoryId: repository.id,
                eventType: type,
              },
            },
            update: {},
            create: {
              repositoryId: repository.id,
              eventType: type,
              cursor: type === EventType.COMMIT ? head.sha : releaseCursor,
              lastCommitSha:
                type === EventType.COMMIT
                  ? head.sha
                  : (latestReleaseCommit?.sha ?? head.sha),
              lastSuccessfulAt: new Date(),
            },
          });
        }
      }
      return subscription.id;
    });
  });
}

export async function updateSubscriptionEvents(
  userId: string,
  subscriptionId: string,
  eventTypes: EventType[],
): Promise<void> {
  if (eventTypes.length === 0) throw new Error("At least one event is required");
  const subscription = await db.subscription.findFirst({
    where: { id: subscriptionId, userId },
    include: { repository: true, events: true },
  });
  if (!subscription) throw new Error("Subscription not found");
  const previouslyEnabled = new Set(
    subscription.events
      .filter((event) => event.enabled)
      .map((event) => event.type),
  );

  await withRepositoryReadToken(
    userId,
    subscription.repository.isPrivate,
    async (token) => {
    const head = await getCommit(
      token,
      subscription.repository.owner,
      subscription.repository.name,
      subscription.repository.defaultBranch,
    );
    const latestRelease = eventTypes.includes(EventType.RELEASE)
      ? await getLatestRelease(
          token,
          subscription.repository.owner,
          subscription.repository.name,
        )
      : null;
    const releaseCommit = latestRelease
      ? await getCommit(
          token,
          subscription.repository.owner,
          subscription.repository.name,
          latestRelease.tag_name,
        )
      : null;

    await db.$transaction(async (tx) => {
      for (const type of [EventType.COMMIT, EventType.RELEASE]) {
        const enabled = eventTypes.includes(type);
        await tx.subscriptionEvent.upsert({
          where: { subscriptionId_type: { subscriptionId, type } },
          update: { enabled },
          create: { subscriptionId, type, enabled },
        });
        if (enabled) {
          // Re-enabling an event resumes from a frozen cursor, so restart it
          // from the current head instead of replaying the whole backlog.
          const resumingAfterPause = !previouslyEnabled.has(type);
          const freshCursor = {
            cursor:
              type === EventType.COMMIT
                ? head.sha
                : latestRelease
                  ? String(latestRelease.id)
                  : "none",
            lastCommitSha:
              type === EventType.COMMIT
                ? head.sha
                : (releaseCommit?.sha ?? head.sha),
            lastSuccessfulAt: new Date(),
            lastError: null,
          };
          if (subscription.repository.isPrivate) {
            await tx.subscriptionPollCursor.upsert({
              where: {
                subscriptionId_eventType: {
                  subscriptionId,
                  eventType: type,
                },
              },
              update: resumingAfterPause ? freshCursor : {},
              create: {
                subscriptionId,
                eventType: type,
                cursor:
                  type === EventType.COMMIT
                    ? head.sha
                    : latestRelease
                      ? String(latestRelease.id)
                      : "none",
                lastCommitSha:
                  type === EventType.COMMIT
                    ? head.sha
                    : (releaseCommit?.sha ?? head.sha),
                lastSuccessfulAt: new Date(),
              },
            });
          } else {
            await tx.repoPollCursor.upsert({
              where: {
                repositoryId_eventType: {
                  repositoryId: subscription.repository.id,
                  eventType: type,
                },
              },
              update: {},
              create: {
                repositoryId: subscription.repository.id,
                eventType: type,
                cursor:
                  type === EventType.COMMIT
                    ? head.sha
                    : latestRelease
                      ? String(latestRelease.id)
                      : "none",
                lastCommitSha:
                  type === EventType.COMMIT
                    ? head.sha
                    : (releaseCommit?.sha ?? head.sha),
                lastSuccessfulAt: new Date(),
              },
            });
          }
        }
      }
    });
  });
}

type ConditionValues = {
  note?: string;
  textPattern?: string;
  filePath?: string;
  lineNumber?: string;
  notifyOnRemoved?: string;
  notifyOnMoved?: string;
  notifyOnChanged?: string;
};

export async function addCondition(
  userId: string,
  subscriptionId: string,
  eventType: EventType,
  conditionType: ConditionType,
  values: ConditionValues,
): Promise<void> {
  await saveCondition(userId, subscriptionId, eventType, conditionType, values);
}

export async function updateCondition(
  userId: string,
  subscriptionId: string,
  conditionId: string,
  values: ConditionValues,
): Promise<void> {
  const condition = await db.condition.findFirst({
    where: {
      id: conditionId,
      subscriptionEvent: { subscriptionId, subscription: { userId } },
    },
    include: { subscriptionEvent: true },
  });
  if (!condition) throw new Error("Condition not found");

  await saveCondition(
    userId,
    subscriptionId,
    condition.subscriptionEvent.type,
    condition.type,
    values,
    condition,
  );
}

async function saveCondition(
  userId: string,
  subscriptionId: string,
  eventType: EventType,
  conditionType: ConditionType,
  values: ConditionValues,
  existing?: Condition,
): Promise<void> {
  const subscription = await db.subscription.findFirst({
    where: { id: subscriptionId, userId },
    include: { repository: true, events: true },
  });
  if (!subscription) throw new Error("Subscription not found");
  const subscriptionEvent = subscription.events.find(
    (event) => event.type === eventType,
  );
  if (!subscriptionEvent || !subscriptionEvent.enabled) {
    throw new Error("Enable this event before saving a condition");
  }

  async function persist(data: Prisma.ConditionUncheckedCreateInput) {
    if (existing) {
      await db.condition.update({ where: { id: existing.id }, data });
    } else {
      await db.condition.create({ data });
    }
  }

  const note =
    z
      .string()
      .trim()
      .max(2000, "Keep the note to 2,000 characters or fewer")
      .parse(values.note ?? "") || null;

  if (conditionType === ConditionType.TEXT_CONTAINS) {
    const textPattern = z
      .string()
      .trim()
      .min(1, "Enter text to match")
      .max(500)
      .parse(values.textPattern);
    await persist({
      subscriptionEventId: subscriptionEvent.id,
      type: conditionType,
      textPattern,
      note,
    });
    return;
  }

  let filePath = values.filePath ?? "";
  let lineNumber = values.lineNumber ?? "";
  const permalink = parseGitHubPermalink(filePath);
  if (permalink) {
    const matchesRepository =
      permalink.owner.toLowerCase() ===
        subscription.repository.owner.toLowerCase() &&
      permalink.repository.toLowerCase() ===
        subscription.repository.name.toLowerCase();
    if (!matchesRepository) {
      throw new Error(
        `Use a permalink from ${subscription.repository.fullName}`,
      );
    }
    filePath = permalink.filePath;
    lineNumber = String(permalink.lineNumber);
  } else if (/github\.com|^\s*\[[^\]]*]\(/i.test(filePath)) {
    throw new Error(
      "Use a GitHub file URL with a line anchor, such as #L42",
    );
  }

  const line = lineConditionSchema.parse({ filePath, lineNumber });
  const triggerValues = [
    values.notifyOnRemoved,
    values.notifyOnMoved,
    values.notifyOnChanged,
  ];
  const omittedLegacyTriggers = triggerValues.every(
    (value) => value === undefined,
  );
  const notifyOnRemoved =
    omittedLegacyTriggers || values.notifyOnRemoved === "on";
  const notifyOnMoved =
    omittedLegacyTriggers || values.notifyOnMoved === "on";
  const notifyOnChanged =
    omittedLegacyTriggers || values.notifyOnChanged === "on";
  if (!notifyOnRemoved && !notifyOnMoved && !notifyOnChanged) {
    throw new Error("Select at least one notification trigger");
  }

  const lineData = {
    subscriptionEventId: subscriptionEvent.id,
    type: conditionType,
    filePath: line.filePath,
    lineNumber: line.lineNumber,
    note,
    notifyOnRemoved,
    notifyOnMoved,
    notifyOnChanged,
  };
  // Notes and trigger changes must not reset the captured line or its progress.
  if (
    existing?.filePath === line.filePath &&
    existing.lineNumber === line.lineNumber
  ) {
    await persist(lineData);
    return;
  }

  await withRepositoryReadToken(
    userId,
    subscription.repository.isPrivate,
    async (token) => {
      let ref = subscription.repository.defaultBranch;
      if (eventType === EventType.RELEASE) {
        const latest = await getLatestRelease(
          token,
          subscription.repository.owner,
          subscription.repository.name,
        );
        if (latest) ref = latest.tag_name;
      }
      const commit = await getCommit(
        token,
        subscription.repository.owner,
        subscription.repository.name,
        ref,
      );
      const content = await getFileLine(
        token,
        subscription.repository.owner,
        subscription.repository.name,
        line.filePath,
        line.lineNumber,
        commit.sha,
      );
      if (content === null) {
        throw new Error(
          "That file or line does not exist at the current repository version",
        );
      }
      await persist({
        ...lineData,
        baselineCommitSha: commit.sha,
        baselineLineContent: content,
        lastObservedCommitSha: commit.sha,
        lastObservedLineContent: content,
        lastObservedLineState: LineMatchState.EXACT,
        movedLineNumber: line.lineNumber,
        removedLineNumber: line.lineNumber,
      });
    },
  );
}

export async function retrySubscription(
  userId: string,
  subscriptionId: string,
): Promise<void> {
  const subscription = await db.subscription.findFirst({
    where: { id: subscriptionId, userId },
    include: { repository: true },
  });
  if (!subscription) throw new Error("Subscription not found");

  const snapshot = await withRepositoryReadToken(
    userId,
    subscription.repository.isPrivate,
    async (token) => {
      const current = await getRepository(
        token,
        subscription.repository.owner,
        subscription.repository.name,
      );
      if (current.private !== subscription.repository.isPrivate) {
        throw new Error(
          `This repository is now ${current.private ? "private" : "public"}. Remove and add the subscription again to change polling mode.`,
        );
      }
      const head = await getCommit(
        token,
        current.owner.login,
        current.name,
        current.default_branch,
      );
      const latestRelease = await getLatestRelease(
        token,
        current.owner.login,
        current.name,
      );
      const releaseCommit = latestRelease
        ? await getCommit(
            token,
            current.owner.login,
            current.name,
            latestRelease.tag_name,
          )
        : null;
      return { head, latestRelease, releaseCommit };
    },
  );

  await db.$transaction(async (tx) => {
    const subscriptionWhere = subscription.repository.isPrivate
      ? { id: subscription.id }
      : { repositoryId: subscription.repository.id };
    await tx.subscription.updateMany({
      where: subscriptionWhere,
      data: {
        errorCode: null,
        errorMessage: null,
        errorAt: null,
      },
    });
    await tx.subscriptionErrorAlert.deleteMany({
      where: subscription.repository.isPrivate
        ? { subscriptionId: subscription.id }
        : { subscription: { repositoryId: subscription.repository.id } },
    });
    if (subscription.repository.isPrivate) {
      for (const eventType of [EventType.COMMIT, EventType.RELEASE]) {
        await tx.subscriptionPollCursor.upsert({
          where: {
            subscriptionId_eventType: {
              subscriptionId: subscription.id,
              eventType,
            },
          },
          update: { lastError: null },
          create: {
            subscriptionId: subscription.id,
            eventType,
            cursor:
              eventType === EventType.COMMIT
                ? snapshot.head.sha
                : snapshot.latestRelease
                  ? String(snapshot.latestRelease.id)
                  : "none",
            lastCommitSha:
              eventType === EventType.COMMIT
                ? snapshot.head.sha
                : (snapshot.releaseCommit?.sha ?? snapshot.head.sha),
            lastSuccessfulAt: new Date(),
          },
        });
      }
      await tx.subscriptionPollCursor.updateMany({
        where: { subscriptionId: subscription.id },
        data: { lastError: null },
      });
    } else {
      for (const eventType of [EventType.COMMIT, EventType.RELEASE]) {
        await tx.repoPollCursor.upsert({
          where: {
            repositoryId_eventType: {
              repositoryId: subscription.repository.id,
              eventType,
            },
          },
          update: { lastError: null },
          create: {
            repositoryId: subscription.repository.id,
            eventType,
            cursor:
              eventType === EventType.COMMIT
                ? snapshot.head.sha
                : snapshot.latestRelease
                  ? String(snapshot.latestRelease.id)
                  : "none",
            lastCommitSha:
              eventType === EventType.COMMIT
                ? snapshot.head.sha
                : (snapshot.releaseCommit?.sha ?? snapshot.head.sha),
            lastSuccessfulAt: new Date(),
          },
        });
      }
      await tx.repoPollCursor.updateMany({
        where: { repositoryId: subscription.repository.id },
        data: { lastError: null },
      });
    }
  });
}

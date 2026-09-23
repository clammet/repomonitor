import { ConditionType, EventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSubscription: vi.fn(),
  createCondition: vi.fn(),
  findCondition: vi.fn(),
  updateCondition: vi.fn(),
  getCommit: vi.fn(),
  getFileLine: vi.fn(),
  getLatestRelease: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    subscription: { findFirst: mocks.findSubscription },
    condition: {
      create: mocks.createCondition,
      findFirst: mocks.findCondition,
      update: mocks.updateCondition,
    },
  },
}));
vi.mock("@/lib/github/client", () => ({
  getCommit: mocks.getCommit,
  getFileLine: mocks.getFileLine,
  getLatestRelease: mocks.getLatestRelease,
}));
vi.mock("@/lib/github/app", () => ({
  withPublicRepositoryToken: (operation: (token: string) => unknown) =>
    operation("token"),
}));
vi.mock("@/lib/github/tokens", () => ({}));

import { addCondition, updateCondition } from "@/lib/subscriptions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCommit.mockResolvedValue({ sha: "abc" });
  mocks.getFileLine.mockResolvedValue("tracked line");
  mocks.getLatestRelease.mockResolvedValue({ tag_name: "v2" });
  mocks.findSubscription.mockResolvedValue({
    repository: {
      owner: "octo",
      name: "repo",
      defaultBranch: "main",
      isPrivate: false,
    },
    events: [{ id: "event", type: EventType.COMMIT, enabled: true }],
  });
});

describe("editing conditions", () => {
  beforeEach(() => {
    mocks.findCondition.mockResolvedValue({
      id: "condition",
      type: ConditionType.LINE_CHANGE,
      subscriptionEvent: { type: EventType.COMMIT },
      filePath: "config.ts",
      lineNumber: 1,
      baselineCommitSha: "original",
      baselineLineContent: "original line",
      movedLineNumber: 9,
    });
  });

  it("requires the condition to belong to the requested subscription and user", async () => {
    mocks.findCondition.mockResolvedValue(null);
    await expect(updateCondition("user", "subscription", "other", {}))
      .rejects.toThrow("Condition not found");
    expect(mocks.findCondition).toHaveBeenCalledWith({
      where: {
        id: "other",
        subscriptionEvent: { subscriptionId: "subscription", subscription: { userId: "user" } },
      },
      include: { subscriptionEvent: true },
    });
    expect(mocks.updateCondition).not.toHaveBeenCalled();
  });

  it("updates text and clears a note without replacing the condition", async () => {
    mocks.findCondition.mockResolvedValue({
      id: "condition",
      type: ConditionType.TEXT_CONTAINS,
      subscriptionEvent: { type: EventType.COMMIT },
    });
    await updateCondition("user", "subscription", "condition", { textPattern: " new match ", note: " " });
    expect(mocks.updateCondition).toHaveBeenCalledWith({
      where: { id: "condition" },
      data: { subscriptionEventId: "event", type: ConditionType.TEXT_CONTAINS, textPattern: "new match", note: null },
    });
    expect(mocks.createCondition).not.toHaveBeenCalled();
  });

  it.each(["config.ts", "https://github.com/octo/repo/blob/main/config.ts#L1"])(
    "preserves tracking when editing the note or triggers for %s", async (filePath) => {
      await updateCondition("user", "subscription", "condition", {
        filePath, lineNumber: "1", note: " Updated reminder ",
        notifyOnRemoved: "", notifyOnMoved: "on", notifyOnChanged: "",
      });
      expect(mocks.updateCondition).toHaveBeenCalledWith({
        where: { id: "condition" },
        data: {
          subscriptionEventId: "event", type: ConditionType.LINE_CHANGE,
          filePath: "config.ts", lineNumber: 1, note: "Updated reminder",
          notifyOnRemoved: false, notifyOnMoved: true, notifyOnChanged: false,
        },
      });
      expect(mocks.getCommit).not.toHaveBeenCalled();
      expect(mocks.getFileLine).not.toHaveBeenCalled();
    },
  );

  it.each([
    { filePath: "other.ts", lineNumber: "1" },
    { filePath: "config.ts", lineNumber: "2" },
  ])("captures a new baseline for a changed location (%j)", async (location) => {
    await updateCondition("user", "subscription", "condition", location);
    expect(mocks.getFileLine).toHaveBeenCalledWith("token", "octo", "repo", location.filePath, Number(location.lineNumber), "abc");
    expect(mocks.updateCondition).toHaveBeenCalledWith({
      where: { id: "condition" },
      data: expect.objectContaining({
        filePath: location.filePath, lineNumber: Number(location.lineNumber),
        baselineCommitSha: "abc", baselineLineContent: "tracked line",
        lastObservedCommitSha: "abc", lastObservedLineContent: "tracked line",
        lastObservedLineState: "EXACT",
        movedLineNumber: Number(location.lineNumber), removedLineNumber: Number(location.lineNumber),
      }),
    });
    expect(mocks.createCondition).not.toHaveBeenCalled();
  });

  it("captures release conditions at the latest release tag", async () => {
    const condition = await mocks.findCondition();
    mocks.findCondition.mockResolvedValue({ ...condition, subscriptionEvent: { type: EventType.RELEASE } });
    const subscription = await mocks.findSubscription();
    mocks.findSubscription.mockResolvedValue({ ...subscription, events: [{ id: "release-event", type: EventType.RELEASE, enabled: true }] });
    await updateCondition("user", "subscription", "condition", { filePath: "other.ts", lineNumber: "2" });
    expect(mocks.getCommit).toHaveBeenCalledWith("token", "octo", "repo", "v2");
  });

  it("keeps the existing condition if the new line cannot be captured", async () => {
    mocks.getFileLine.mockResolvedValue(null);
    await expect(updateCondition("user", "subscription", "condition", { filePath: "missing.ts", lineNumber: "1" }))
      .rejects.toThrow("That file or line does not exist");
    expect(mocks.updateCondition).not.toHaveBeenCalled();
  });

  it("rejects disabling every line trigger", async () => {
    await expect(updateCondition("user", "subscription", "condition", {
      filePath: "config.ts", lineNumber: "1",
      notifyOnRemoved: "", notifyOnMoved: "", notifyOnChanged: "",
    })).rejects.toThrow("Select at least one notification trigger");
    expect(mocks.updateCondition).not.toHaveBeenCalled();
  });
});

describe.each([ConditionType.TEXT_CONTAINS, ConditionType.LINE_CHANGE])(
  "%s condition notes",
  (conditionType) => {
    const values = { textPattern: "retry", filePath: "config.ts", lineNumber: "1" };

    it("persists the note with surrounding whitespace removed and line breaks intact", async () => {
      await addCondition("user", "subscription", EventType.COMMIT, conditionType, {
        ...values,
        note: "  Review the workaround\nRemove it when fixed.  ",
      });

      expect(mocks.createCondition).toHaveBeenCalledWith({
        data: expect.objectContaining({
          note: "Review the workaround\nRemove it when fixed.",
          subscriptionEventId: "event",
          type: conditionType,
        }),
      });
    });

    it.each([undefined, "", " \n "])("stores an absent or blank note as null (%j)", async (note) => {
      await addCondition("user", "subscription", EventType.COMMIT, conditionType, {
        ...values,
        note,
      });

      expect(mocks.createCondition).toHaveBeenCalledWith({
        data: expect.objectContaining({ note: null }),
      });
    });

    it("rejects oversized notes before saving a condition", async () => {
      await expect(
        addCondition("user", "subscription", EventType.COMMIT, conditionType, {
          ...values,
          note: "a".repeat(2001),
        }),
      ).rejects.toThrow("Keep the note to 2,000 characters or fewer");
      expect(mocks.createCondition).not.toHaveBeenCalled();
    });
  },
);

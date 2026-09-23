import { describe, expect, it } from "vitest";

import {
  buildRepositoryNotificationEmail,
  parseNotificationPayload,
  serializeNotificationPayload,
  textMatchContexts,
  type NotificationPayload,
  type RepositoryNotification,
} from "@/lib/email/notification";

function storedNotification(
  overrides: Partial<RepositoryNotification> & {
    payload?: NotificationPayload;
  } = {},
): RepositoryNotification {
  const {
    payload = {
      version: 1,
      subjectTitle: "fix retry timeout",
      condition: {
        kind: "text",
        pattern: "timeout",
        matches: [
          {
            format: "diff",
            label: "Diff · src/client.ts",
            filePath: "src/client.ts",
            patch: "@@ -8,2 +8,2 @@\n-timeout = 5\n+timeout = 10",
          },
        ],
      },
    },
    ...notificationOverrides
  } = overrides;
  return {
    eventKey: "commit:abc",
    eventType: "COMMIT",
    eventTitle: "octo/repo: fix retry timeout",
    eventUrl: "https://github.com/octo/repo/commit/abc",
    summary: serializeNotificationPayload(payload),
    createdAt: new Date("2026-07-28T00:00:00Z"),
    condition: {
      type:
        payload.condition.kind === "text" ? "TEXT_CONTAINS" : "LINE_CHANGE",
      textPattern:
        payload.condition.kind === "text"
          ? payload.condition.pattern
          : null,
    },
    ...notificationOverrides,
  };
}

describe("notification match context", () => {
  it("captures matching prose, paths, and diffs with source labels", () => {
    const contexts = textMatchContexts("retry", "RELEASE", {
      title: "Retry release",
      body: "Safer RETRY behavior for failed requests.",
      commitMessages: ["docs: unrelated", "fix retry budget"],
      files: [
        {
          filename: "src/retry/client.ts",
          patch: "@@ -1 +1 @@\n-retries = 1\n+retry = 2",
        },
      ],
    });

    expect(contexts.map((context) => context.label)).toEqual([
      "Release title",
      "Release notes",
      "Included commit",
      "Path",
      "Diff · src/retry/client.ts",
    ]);
    expect(contexts.at(-1)).toMatchObject({
      format: "diff",
      filePath: "src/retry/client.ts",
    });
  });

  it("round-trips valid payloads and rejects arbitrary legacy summaries", () => {
    const payload: NotificationPayload = {
      version: 1,
      subjectTitle: "Release 2.0",
      condition: {
        kind: "line",
        triggers: ["moved", "changed"],
        filePath: "config.ts",
        lineNumber: 12,
        capturedLine: "enabled = true",
        previousLine: "enabled = true",
        currentLine: "other = true",
        previousMovedLineNumber: 12,
        currentMovedLineNumber: 18,
        previousRemovedLineNumber: 12,
        currentRemovedLineNumber: 18,
      },
    };

    expect(parseNotificationPayload(serializeNotificationPayload(payload))).toEqual(
      payload,
    );
    expect(parseNotificationPayload("Matched text “retry”.")).toBeNull();
  });
});

describe("repository notification email", () => {
  it("includes each condition's note and escapes user content in HTML", () => {
    const note = 'Check <script>alert("note")</script> & retry\nThen remove the workaround.';
    const email = buildRepositoryNotificationEmail({
      to: "user@example.com",
      repositoryFullName: "octo/repo",
      settingsUrl: "https://example.com/settings",
      notifications: [
        storedNotification({ condition: { type: "TEXT_CONTAINS", note } }),
        storedNotification({
          condition: { type: "LINE_CHANGE", note: "Review the fallback" },
          summary: "Tracked line changed",
        }),
        storedNotification(),
      ],
    });

    expect(email.text).toContain(`Your note: ${note}`);
    expect(email.text).toContain("Your note: Review the fallback");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;note&quot;)&lt;/script&gt; &amp; retry\nThen remove the workaround.");
    expect(email.html).not.toContain("<script>");
    expect(email.html?.match(/Your note:/g)).toHaveLength(2);
    expect(email.text.match(/Your note:/g)).toHaveLength(2);
  });

  it("collates commit and release triggers with canonical subject labels", () => {
    const commit = storedNotification();
    const release = storedNotification({
      eventKey: "release:42",
      eventType: "RELEASE",
      eventTitle: "octo/repo released Release 2.0",
      eventUrl: "https://github.com/octo/repo/releases/tag/v2",
      createdAt: new Date("2026-07-28T01:00:00Z"),
      payload: {
        version: 1,
        subjectTitle: "Release 2.0",
        condition: {
          kind: "line",
          triggers: ["changed", "removed"],
          filePath: "src/client.ts",
          lineNumber: 9,
          capturedLine: "timeout = 5",
          previousLine: "timeout = 5",
          currentLine: "timeout = 10",
          previousRemovedLineNumber: 9,
          currentRemovedLineNumber: null,
          patch: "@@ -8,2 +8,2 @@\n-timeout = 5\n+timeout = 10",
        },
      },
    });

    const email = buildRepositoryNotificationEmail({
      to: "reader@example.com",
      repositoryFullName: "octo/repo",
      settingsUrl: "https://repomonitor.test/settings",
      notifications: [release, commit],
    });

    expect(email.subject).toBe(
      "[RepoMonitor] [Commit+Release]: [Match+Removed+Changed] Release 2.0 (+1 more)",
    );
    expect(email.text).toContain("2 triggers across 2 events");
    expect(email.text).toContain("COMMIT: fix retry timeout");
    expect(email.text).toContain("RELEASE: Release 2.0");
    expect(email.html).toContain("background:#e6ffec");
    expect(email.html).toContain("background:#ffebe9");
  });

  it("uses the earliest commit title and highlights matched text in snippets and diffs", () => {
    const first = storedNotification({
      payload: {
        version: 1,
        subjectTitle: "first change",
        condition: {
          kind: "text",
          pattern: "BREAKING",
          matches: [
            {
              format: "snippet",
              label: "Commit message",
              text: "fix: BREAKING retry behavior <script>",
            },
            {
              format: "diff",
              label: "Diff · src/client.ts",
              filePath: "src/client.ts",
              patch: "@@ -1 +1 @@\n-old behavior\n+BREAKING behavior",
            },
          ],
        },
      },
    });
    const later = storedNotification({
      eventKey: "commit:def",
      createdAt: new Date("2026-07-28T02:00:00Z"),
      payload: {
        version: 1,
        subjectTitle: "second change",
        condition: {
          kind: "line",
          triggers: ["moved"],
          filePath: "src/client.ts",
          lineNumber: 1,
          capturedLine: "old behavior",
          previousLine: "old behavior",
          currentLine: "new behavior",
          previousMovedLineNumber: 1,
          currentMovedLineNumber: 7,
        },
      },
    });

    const email = buildRepositoryNotificationEmail({
      to: "reader@example.com",
      repositoryFullName: "octo/repo",
      settingsUrl: "https://repomonitor.test/settings",
      notifications: [later, first],
    });

    expect(email.subject).toBe(
      "[RepoMonitor] [Commit]: [Match+Moved] first change (+1 more)",
    );
    expect(email.html).toMatch(
      /<mark[^>]*>BREAKING<\/mark> retry behavior &lt;script&gt;/,
    );
    expect(email.html).not.toContain("<script>");
    expect(email.text).toContain("⟦BREAKING⟧ retry behavior <script>");
    expect(email.text).toContain("MOVED FROM LINE 1 TO LINE 7");
    expect(email.text).toContain("@@ -1,1 +1,1 @@ monitored line");
  });

  it("labels a readded line and includes its new tracked location", () => {
    const readded = storedNotification({
      payload: {
        version: 1,
        subjectTitle: "restore configuration",
        condition: {
          kind: "line",
          triggers: ["readded"],
          filePath: "config.ts",
          lineNumber: 4,
          capturedLine: "enabled = true",
          previousLine: "other = true",
          currentLine: "other = true",
          previousRemovedLineNumber: null,
          currentRemovedLineNumber: 19,
        },
      },
    });

    const email = buildRepositoryNotificationEmail({
      to: "reader@example.com",
      repositoryFullName: "octo/repo",
      settingsUrl: "https://repomonitor.test/settings",
      notifications: [readded],
    });

    expect(email.subject).toBe(
      "[RepoMonitor] [Commit]: [Readded] restore configuration",
    );
    expect(email.text).toContain("READDED AT LINE 19");
    expect(email.html).toContain("Readded at line 19");
  });

  it("renders legacy queued notifications safely", () => {
    const email = buildRepositoryNotificationEmail({
      to: "reader@example.com",
      repositoryFullName: "octo/repo",
      settingsUrl: "https://repomonitor.test/settings",
      notifications: [
        {
          eventKey: "commit:legacy",
          eventType: "COMMIT",
          eventTitle: "octo/repo: legacy alert",
          eventUrl: "https://github.com/octo/repo/commit/legacy",
          summary: "Matched text “<unsafe>”.",
          createdAt: new Date("2026-07-27T00:00:00Z"),
          condition: {
            type: "TEXT_CONTAINS",
            textPattern: "<unsafe>",
          },
        },
      ],
    });

    expect(email.subject).toBe(
      "[RepoMonitor] [Commit]: [Match] legacy alert",
    );
    expect(email.html).toContain("Matched text “&lt;unsafe&gt;”.");
    expect(email.html).not.toContain("<unsafe>");
  });
});

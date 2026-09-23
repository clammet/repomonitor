import type { TextEventMaterial } from "@/lib/domain/conditions";
import { escapeHtml, type OutboundEmail } from "@/lib/email/message";

export type NotificationEventType = "COMMIT" | "RELEASE";
export type NotificationConditionType = "TEXT_CONTAINS" | "LINE_CHANGE";
export type LineTrigger = "removed" | "readded" | "moved" | "changed";

export type TextMatchContext =
  | {
      format: "snippet";
      label: string;
      text: string;
    }
  | {
      format: "diff";
      label: string;
      filePath: string;
      patch: string;
    };

export type NotificationPayload = {
  version: 1;
  subjectTitle: string;
  condition:
    | {
        kind: "text";
        pattern: string;
        matches: TextMatchContext[];
      }
    | {
        kind: "line";
        triggers: LineTrigger[];
        filePath: string;
        lineNumber: number;
        capturedLine: string;
        previousLine: string | null;
        currentLine: string | null;
        previousMovedLineNumber?: number | null;
        currentMovedLineNumber?: number | null;
        previousRemovedLineNumber?: number | null;
        currentRemovedLineNumber?: number | null;
        patch?: string;
      };
};

export type RepositoryNotification = {
  eventKey: string;
  eventType: NotificationEventType;
  eventTitle: string;
  eventUrl: string;
  summary: string;
  createdAt: Date | string;
  condition: {
    type: NotificationConditionType;
    note?: string | null;
    textPattern?: string | null;
  };
};

function containsCaseInsensitive(value: string, pattern: string): boolean {
  return value.toLocaleLowerCase().includes(pattern.toLocaleLowerCase());
}

function snippetAroundMatch(
  value: string,
  pattern: string,
  contextLength = 180,
): string {
  const index = value.toLocaleLowerCase().indexOf(pattern.toLocaleLowerCase());
  if (index < 0) return value;
  const start = Math.max(0, index - contextLength);
  const end = Math.min(value.length, index + pattern.length + contextLength);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${
    end < value.length ? "…" : ""
  }`;
}

export function textMatchContexts(
  pattern: string,
  eventType: NotificationEventType,
  material: TextEventMaterial,
): TextMatchContext[] {
  const needle = pattern.trim();
  if (!needle) return [];

  const contexts: TextMatchContext[] = [];
  const addSnippet = (label: string, value: string | null | undefined) => {
    if (!value || !containsCaseInsensitive(value, needle)) return;
    contexts.push({
      format: "snippet",
      label,
      text: snippetAroundMatch(value, needle),
    });
  };

  addSnippet(
    eventType === "RELEASE" ? "Release title" : "Commit message",
    material.title,
  );
  addSnippet("Release notes", material.body);
  for (const message of material.commitMessages ?? []) {
    addSnippet("Included commit", message);
  }
  for (const file of material.files ?? []) {
    addSnippet("Path", file.filename);
    addSnippet("Previous path", file.previousFilename);
    if (file.patch && containsCaseInsensitive(file.patch, needle)) {
      contexts.push({
        format: "diff",
        label: `Diff · ${file.filename}`,
        filePath: file.filename,
        patch: file.patch,
      });
    }
  }
  return contexts;
}

export function serializeNotificationPayload(
  payload: NotificationPayload,
): string {
  return JSON.stringify(payload);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isNumberOrNullOrUndefined(
  value: unknown,
): value is number | null | undefined {
  return typeof value === "number" || value === null || value === undefined;
}

export function parseNotificationPayload(
  value: string,
): NotificationPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<NotificationPayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.subjectTitle !== "string" ||
      !parsed.condition ||
      typeof parsed.condition !== "object"
    ) {
      return null;
    }
    if (parsed.condition.kind === "text") {
      if (
        typeof parsed.condition.pattern !== "string" ||
        !Array.isArray(parsed.condition.matches)
      ) {
        return null;
      }
      const matches = parsed.condition.matches.every(
        (match) =>
          match &&
          typeof match === "object" &&
          ((match.format === "snippet" &&
            typeof match.label === "string" &&
            typeof match.text === "string") ||
            (match.format === "diff" &&
              typeof match.label === "string" &&
              typeof match.filePath === "string" &&
              typeof match.patch === "string")),
      );
      return matches ? (parsed as NotificationPayload) : null;
    }
    if (parsed.condition.kind === "line") {
      const condition = parsed.condition;
      const validTriggers =
        Array.isArray(condition.triggers) &&
        condition.triggers.every((trigger) =>
          ["removed", "readded", "moved", "changed"].includes(trigger),
        );
      if (
        !validTriggers ||
        typeof condition.filePath !== "string" ||
        typeof condition.lineNumber !== "number" ||
        typeof condition.capturedLine !== "string" ||
        !isStringOrNull(condition.previousLine) ||
        !isStringOrNull(condition.currentLine) ||
        !isNumberOrNullOrUndefined(condition.previousMovedLineNumber) ||
        !isNumberOrNullOrUndefined(condition.currentMovedLineNumber) ||
        !isNumberOrNullOrUndefined(condition.previousRemovedLineNumber) ||
        !isNumberOrNullOrUndefined(condition.currentRemovedLineNumber) ||
        (condition.patch !== undefined &&
          typeof condition.patch !== "string")
      ) {
        return null;
      }
      return parsed as NotificationPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function legacySubjectTitle(
  repositoryFullName: string,
  eventTitle: string,
): string {
  const commitPrefix = `${repositoryFullName}: `;
  if (eventTitle.startsWith(commitPrefix)) {
    return eventTitle.slice(commitPrefix.length);
  }
  const releasePrefix = `${repositoryFullName} released `;
  if (eventTitle.startsWith(releasePrefix)) {
    return eventTitle.slice(releasePrefix.length);
  }
  return eventTitle;
}

function legacyLineTriggers(summary: string): LineTrigger[] {
  const lower = summary.toLocaleLowerCase();
  const triggers: LineTrigger[] = [];
  if (lower.includes("removed")) triggers.push("removed");
  if (lower.includes("readded")) triggers.push("readded");
  if (lower.includes("moved")) triggers.push("moved");
  if (lower.includes("changed")) triggers.push("changed");
  return triggers.length > 0 ? triggers : ["changed"];
}

function conditionLabels(
  notifications: RepositoryNotification[],
): Array<"Match" | "Removed" | "Readded" | "Moved" | "Changed"> {
  const found = new Set<string>();
  for (const notification of notifications) {
    const payload = parseNotificationPayload(notification.summary);
    if (payload?.condition.kind === "text") {
      found.add("Match");
      continue;
    }
    if (payload?.condition.kind === "line") {
      for (const trigger of payload.condition.triggers) {
        found.add(
          `${trigger.charAt(0).toLocaleUpperCase()}${trigger.slice(1)}`,
        );
      }
      continue;
    }
    if (notification.condition.type === "TEXT_CONTAINS") {
      found.add("Match");
    } else {
      for (const trigger of legacyLineTriggers(notification.summary)) {
        found.add(
          `${trigger.charAt(0).toLocaleUpperCase()}${trigger.slice(1)}`,
        );
      }
    }
  }
  return (
    ["Match", "Removed", "Readded", "Moved", "Changed"] as const
  ).filter((label) => found.has(label));
}

function eventTypeLabel(notifications: RepositoryNotification[]): string {
  const types = new Set(notifications.map((notification) => notification.eventType));
  if (types.has("COMMIT") && types.has("RELEASE")) return "Commit+Release";
  return types.has("RELEASE") ? "Release" : "Commit";
}

function truncateSubjectTitle(value: string, maxLength = 96): string {
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length <= maxLength) return firstLine;
  return `${firstLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function subjectFor(
  repositoryFullName: string,
  notifications: RepositoryNotification[],
): string {
  const sorted = [...notifications].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const release = sorted.find(
    (notification) => notification.eventType === "RELEASE",
  );
  const preferred = release ?? sorted[0];
  const payload = preferred
    ? parseNotificationPayload(preferred.summary)
    : null;
  const title = preferred
    ? payload?.subjectTitle ??
      legacySubjectTitle(repositoryFullName, preferred.eventTitle)
    : repositoryFullName;
  const eventCount = new Set(sorted.map((notification) => notification.eventKey))
    .size;
  const more = eventCount > 1 ? ` (+${eventCount - 1} more)` : "";
  const labels = conditionLabels(sorted);
  return `[RepoMonitor] [${eventTypeLabel(sorted)}]: [${labels.join(
    "+",
  )}] ${truncateSubjectTitle(title)}${more}`;
}

function highlightHtml(value: string, pattern: string): string {
  const needle = pattern.trim();
  if (!needle) return escapeHtml(value);
  const lowerValue = value.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const index = lowerValue.indexOf(lowerNeedle, offset);
    if (index < 0) break;
    parts.push(escapeHtml(value.slice(offset, index)));
    parts.push(
      `<mark style="background:#fff1a8;color:inherit;padding:0 1px">${escapeHtml(
        value.slice(index, index + needle.length),
      )}</mark>`,
    );
    offset = index + needle.length;
  }
  parts.push(escapeHtml(value.slice(offset)));
  return parts.join("");
}

function highlightText(value: string, pattern: string): string {
  const needle = pattern.trim();
  if (!needle) return value;
  const lowerValue = value.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const index = lowerValue.indexOf(lowerNeedle, offset);
    if (index < 0) break;
    parts.push(value.slice(offset, index));
    parts.push(`⟦${value.slice(index, index + needle.length)}⟧`);
    offset = index + needle.length;
  }
  parts.push(value.slice(offset));
  return parts.join("");
}

type DiffLine = {
  oldLine: number | null;
  newLine: number | null;
  kind: "add" | "remove" | "context" | "hunk" | "meta";
  text: string;
};

function parseDiff(patch: string): DiffLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return patch.split(/\r?\n/).map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { oldLine: null, newLine: null, kind: "hunk", text };
    }
    if (
      oldLine === null ||
      newLine === null ||
      text.startsWith("--- ") ||
      text.startsWith("+++ ") ||
      text.startsWith("\\")
    ) {
      return { oldLine: null, newLine: null, kind: "meta", text };
    }
    if (text.startsWith("+")) {
      const result = { oldLine: null, newLine, kind: "add" as const, text };
      newLine += 1;
      return result;
    }
    if (text.startsWith("-")) {
      const result = { oldLine, newLine: null, kind: "remove" as const, text };
      oldLine += 1;
      return result;
    }
    const result = {
      oldLine,
      newLine,
      kind: "context" as const,
      text,
    };
    oldLine += 1;
    newLine += 1;
    return result;
  });
}

function diffBackground(kind: DiffLine["kind"]): string {
  if (kind === "add") return "#e6ffec";
  if (kind === "remove") return "#ffebe9";
  if (kind === "hunk") return "#ddf4ff";
  if (kind === "meta") return "#f6f8fa";
  return "#ffffff";
}

function renderDiffHtml(patch: string, pattern = ""): string {
  const rows = parseDiff(patch)
    .map(
      (line) =>
        `<tr style="background:${diffBackground(line.kind)}">` +
        `<td style="width:42px;padding:0 7px;text-align:right;color:#6e7781;border-right:1px solid #d0d7de;user-select:none">${line.oldLine ?? ""}</td>` +
        `<td style="width:42px;padding:0 7px;text-align:right;color:#6e7781;border-right:1px solid #d0d7de;user-select:none">${line.newLine ?? ""}</td>` +
        `<td style="padding:0 8px;white-space:pre-wrap;word-break:break-word">${highlightHtml(line.text, pattern)}</td>` +
        "</tr>",
    )
    .join("");
  return `<div style="overflow-x:auto;border:1px solid #d0d7de;border-radius:6px"><table role="presentation" style="width:100%;border-collapse:collapse;font:12px/20px ui-monospace,SFMono-Regular,Consolas,Liberation Mono,monospace;color:#1f2328">${rows}</table></div>`;
}

function renderDiffText(patch: string, pattern = ""): string {
  return parseDiff(patch)
    .map((line) => {
      const oldNumber = line.oldLine === null ? "" : String(line.oldLine);
      const newNumber = line.newLine === null ? "" : String(line.newLine);
      return `${oldNumber.padStart(5)} ${newNumber.padStart(5)} | ${highlightText(
        line.text,
        pattern,
      )}`;
    })
    .join("\n");
}

function fallbackLinePatch(
  previousLine: string | null,
  currentLine: string | null,
): string {
  return [
    "@@ -1,1 +1,1 @@ monitored line",
    `-${previousLine ?? "(line did not exist)"}`,
    `+${currentLine ?? "(line does not exist)"}`,
  ].join("\n");
}

function lineTriggerDescription(
  trigger: LineTrigger,
  condition: Extract<NotificationPayload["condition"], { kind: "line" }>,
): string {
  if (trigger === "moved") {
    const from = condition.previousMovedLineNumber ?? condition.lineNumber;
    const to = condition.currentMovedLineNumber;
    return to === null || to === undefined
      ? `Moved from line ${from}`
      : `Moved from line ${from} to line ${to}`;
  }
  if (trigger === "removed") {
    const from = condition.previousRemovedLineNumber ?? condition.lineNumber;
    return `Removed from line ${from}`;
  }
  if (trigger === "readded") {
    const to = condition.currentRemovedLineNumber;
    return to === null || to === undefined
      ? "Readded"
      : `Readded at line ${to}`;
  }
  return `Changed at original line ${condition.lineNumber}`;
}

function renderTextConditionHtml(
  condition: Extract<NotificationPayload["condition"], { kind: "text" }>,
): string {
  const contexts =
    condition.matches.length > 0
      ? condition.matches
          .map((match) => {
            if (match.format === "diff") {
              return `<div style="margin-top:12px"><div style="margin-bottom:5px;font-size:12px;font-weight:600;color:#57606a">${escapeHtml(match.label)}</div>${renderDiffHtml(match.patch, condition.pattern)}</div>`;
            }
            return `<div style="margin-top:12px"><div style="margin-bottom:5px;font-size:12px;font-weight:600;color:#57606a">${escapeHtml(match.label)}</div><pre style="margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;font:12px/18px ui-monospace,SFMono-Regular,Consolas,Liberation Mono,monospace;color:#1f2328">${highlightHtml(match.text, condition.pattern)}</pre></div>`;
          })
          .join("")
      : `<p style="margin:8px 0 0;color:#57606a">Match context was not available for this previously queued notification.</p>`;
  return `<div><div style="font-weight:600">Text match: <code style="padding:2px 5px;border-radius:4px;background:#fff1a8">${escapeHtml(condition.pattern)}</code></div>${contexts}</div>`;
}

function renderTextConditionText(
  condition: Extract<NotificationPayload["condition"], { kind: "text" }>,
): string {
  const contexts = condition.matches.map((match) => {
    const content =
      match.format === "diff"
        ? renderDiffText(match.patch, condition.pattern)
        : highlightText(match.text, condition.pattern);
    return `  ${match.label}:\n${content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}`;
  });
  return [`MATCH: ${condition.pattern}`, ...contexts].join("\n");
}

function renderLineConditionHtml(
  condition: Extract<NotificationPayload["condition"], { kind: "line" }>,
): string {
  const triggerText = condition.triggers
    .map((trigger) => lineTriggerDescription(trigger, condition))
    .join(" + ");
  const patch =
    condition.patch ??
    fallbackLinePatch(condition.previousLine, condition.currentLine);
  return `<div><div style="font-weight:600">${escapeHtml(triggerText)}: <code style="font-weight:400">${escapeHtml(condition.filePath)}:${condition.lineNumber}</code></div><div style="margin-top:12px">${renderDiffHtml(patch)}</div></div>`;
}

function renderLineConditionText(
  condition: Extract<NotificationPayload["condition"], { kind: "line" }>,
): string {
  const patch =
    condition.patch ??
    fallbackLinePatch(condition.previousLine, condition.currentLine);
  return `${condition.triggers
    .map((trigger) => lineTriggerDescription(trigger, condition).toLocaleUpperCase())
    .join(" + ")}: ${condition.filePath}\n${renderDiffText(patch)}`;
}

function eventHeading(
  repositoryFullName: string,
  notification: RepositoryNotification,
  payload: NotificationPayload | null,
): string {
  return (
    payload?.subjectTitle ??
    legacySubjectTitle(repositoryFullName, notification.eventTitle)
  );
}

export function buildRepositoryNotificationEmail({
  to,
  repositoryFullName,
  settingsUrl,
  notifications,
}: {
  to: string;
  repositoryFullName: string;
  settingsUrl: string;
  notifications: RepositoryNotification[];
}): OutboundEmail {
  const sorted = [...notifications].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const events = new Map<string, RepositoryNotification[]>();
  for (const notification of sorted) {
    const eventNotifications = events.get(notification.eventKey) ?? [];
    eventNotifications.push(notification);
    events.set(notification.eventKey, eventNotifications);
  }

  const textEvents: string[] = [];
  const htmlEvents: string[] = [];
  for (const eventNotifications of events.values()) {
    const first = eventNotifications[0];
    const firstPayload = parseNotificationPayload(first.summary);
    const heading = eventHeading(repositoryFullName, first, firstPayload);
    const typeLabel = first.eventType === "RELEASE" ? "Release" : "Commit";
    const textConditions = eventNotifications.map((notification) => {
      const payload = parseNotificationPayload(notification.summary);
      let content: string;
      if (payload?.condition.kind === "text") {
        content = renderTextConditionText(payload.condition);
      } else if (payload?.condition.kind === "line") {
        content = renderLineConditionText(payload.condition);
      } else {
        content = notification.summary;
      }
      const note = notification.condition.note;
      return note ? `${content}\n\nYour note: ${note}` : content;
    });
    textEvents.push(
      `${typeLabel.toLocaleUpperCase()}: ${heading}\n${first.eventUrl}\n\n${textConditions.join(
        "\n\n",
      )}`,
    );

    const htmlConditions = eventNotifications
      .map((notification) => {
        const payload = parseNotificationPayload(notification.summary);
        let content: string;
        if (payload?.condition.kind === "text") {
          content = renderTextConditionHtml(payload.condition);
        } else if (payload?.condition.kind === "line") {
          content = renderLineConditionHtml(payload.condition);
        } else {
          content = `<p style="margin:0">${escapeHtml(notification.summary)}</p>`;
        }
        const note = notification.condition.note;
        const noteHtml = note
          ? `<p style="margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere"><strong>Your note:</strong> ${escapeHtml(note)}</p>`
          : "";
        return `<div style="margin-top:14px;padding-top:14px;border-top:1px solid #d8dee4">${content}${noteHtml}</div>`;
      })
      .join("");
    htmlEvents.push(
      `<section style="margin-top:20px;padding:16px;border:1px solid #d0d7de;border-radius:8px;background:#ffffff"><div><span style="display:inline-block;padding:2px 7px;border-radius:999px;background:#ddf4ff;color:#0969da;font-size:11px;font-weight:700;text-transform:uppercase">${typeLabel}</span></div><h2 style="margin:8px 0 0;font-size:17px;line-height:24px"><a href="${escapeHtml(first.eventUrl)}" style="color:#0969da;text-decoration:none">${escapeHtml(heading)}</a></h2>${htmlConditions}</section>`,
    );
  }

  const triggerCount = sorted.length;
  const eventCount = events.size;
  const summary = `${triggerCount} trigger${triggerCount === 1 ? "" : "s"} across ${eventCount} event${eventCount === 1 ? "" : "s"}`;
  const subject = subjectFor(repositoryFullName, sorted);
  const text = `RepoMonitor found ${summary} in ${repositoryFullName}.\n\n${textEvents.join(
    "\n\n========================================\n\n",
  )}\n\nNotification settings: ${settingsUrl}`;
  const html = `<div style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328"><div style="max-width:760px;margin:0 auto"><h1 style="margin:0;font-size:21px;line-height:28px">Repository activity matched</h1><p style="margin:6px 0 0;color:#57606a">${escapeHtml(summary)} in <strong>${escapeHtml(repositoryFullName)}</strong>.</p>${htmlEvents.join("")}<p style="margin:20px 0 0;font-size:12px;color:#57606a"><a href="${escapeHtml(settingsUrl)}" style="color:#0969da">Notification settings</a></p></div></div>`;

  return { to, subject, text, html };
}

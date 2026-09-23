import { ConditionType, EventType } from "@prisma/client";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EventBadge } from "@/app/_components/event-badge";
import { Flash } from "@/app/_components/flash";
import { Header } from "@/app/_components/header";
import { AddConditionMenu } from "@/app/subscriptions/[id]/_components/add-condition-menu";
import { EditConditionDialog } from "@/app/subscriptions/[id]/_components/edit-condition-dialog";
import { TextConditionForm } from "@/app/subscriptions/[id]/_components/text-condition-form";
import { LineConditionForm } from "@/app/subscriptions/[id]/_components/line-condition-form";
import { LocalSentAt } from "@/app/subscriptions/[id]/_components/local-sent-at";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
};

function shortSha(value: string | null) {
  return value?.slice(0, 7) ?? "—";
}

function lineTriggerNames(condition: {
  notifyOnRemoved: boolean;
  notifyOnMoved: boolean;
  notifyOnChanged: boolean;
}) {
  return [
    condition.notifyOnRemoved ? "removed/readded" : null,
    condition.notifyOnMoved ? "moved" : null,
    condition.notifyOnChanged ? "changed" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export default async function SubscriptionPage({
  params,
  searchParams,
}: PageProps) {
  const [{ id }, query, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const subscription = await db.subscription.findFirst({
    where: { id, userId: user.id },
    include: {
      repository: true,
      events: {
        orderBy: { type: "asc" },
        include: {
          conditions: {
            orderBy: { createdAt: "asc" },
            include: {
              notifications: {
                orderBy: { createdAt: "desc" },
                take: 3,
              },
            },
          },
        },
      },
    },
  });
  if (!subscription) notFound();

  const eventMap = new Map(subscription.events.map((event) => [event.type, event]));
  const enabledEvents = subscription.events.filter((event) => event.enabled);

  return (
    <>
      <Header user={user} />
      <main className="shell detail-page">
        <Flash notice={query.notice} error={query.error} />
        <Link className="back-link" href="/">
          ← Subscriptions
        </Link>
        <section className="detail-hero">
          <div>
            <div className="detail-kicker">
              <span
                className={`status-line ${subscription.errorAt ? "status-line-error" : ""}`}
              >
                <i />
                {subscription.errorAt ? "Monitoring paused" : "Monitoring"}
              </span>
              <span>{subscription.repository.isPrivate ? "Private" : "Public"}</span>
            </div>
            <h1>{subscription.repository.fullName}</h1>
            <p>
              Watching <strong>{subscription.repository.defaultBranch}</strong>{" "}
              once a day{" "}
              {subscription.repository.isPrivate
                ? "with your GitHub user account authorization."
                : "through public GitHub access."}
            </p>
            <a
              className="external-link"
              href={subscription.repository.htmlUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub ↗
            </a>
          </div>
          <form
            className="event-settings"
            action={`/api/subscriptions/${id}`}
            method="post"
          >
            <strong>Events</strong>
            <label>
              <input
                type="checkbox"
                name="commits"
                defaultChecked={eventMap.get(EventType.COMMIT)?.enabled}
              />
              Commits
            </label>
            <label>
              <input
                type="checkbox"
                name="releases"
                defaultChecked={eventMap.get(EventType.RELEASE)?.enabled}
              />
              Releases
            </label>
            <button className="button button-secondary button-small" type="submit">
              Save
            </button>
          </form>
        </section>

        {subscription.errorAt ? (
          <section className="subscription-error" role="alert">
            <div>
              <p className="eyebrow">Repository access error</p>
              <h2>Monitoring is paused</h2>
              <p>
                {subscription.errorMessage ??
                  "RepoMonitor cannot currently access this repository."}
              </p>
              <small>
                Polling stopped {subscription.errorAt.toLocaleString("en-AU")}.
                It will not be attempted again until access is restored and the
                subscription is retried.
              </small>
            </div>
            <form action={`/api/subscriptions/${id}/retry`} method="post">
              <button className="button button-primary" type="submit">
                Retry repository access
              </button>
            </form>
          </section>
        ) : null}

        {enabledEvents.map((event) => (
          <section className="event-section" key={event.id}>
            <header className="event-section-header">
              <div>
                <EventBadge type={event.type} />
                <h2>
                  {event.type === EventType.COMMIT
                    ? "Commit conditions"
                    : "Release conditions"}
                </h2>
                <p>
                  {event.type === EventType.COMMIT
                    ? "Matches new commits on the default branch."
                    : "Release text and code are checked at the release tag."}
                </p>
              </div>
              <AddConditionMenu menuId={`condition-menu-${event.id}`}>
                <TextConditionForm
                  action={`/api/subscriptions/${id}/conditions`}
                  eventType={event.type}
                />
                <div className="menu-rule" />
                <LineConditionForm
                  action={`/api/subscriptions/${id}/conditions`}
                  eventType={event.type}
                  repositoryOwner={subscription.repository.owner}
                  repositoryName={subscription.repository.name}
                />
              </AddConditionMenu>
            </header>

            {event.conditions.length ? (
              <div className="condition-list">
                {event.conditions.map((condition, index) => (
                  <article className="condition-row" key={condition.id}>
                    <span className="condition-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="condition-icon" aria-hidden="true">
                      {condition.type === ConditionType.TEXT_CONTAINS ? "T" : "≠"}
                    </div>
                    <div className="condition-copy">
                      <small>
                        {condition.type === ConditionType.TEXT_CONTAINS
                          ? "TEXT CONTAINS"
                          : "LINE CHANGE"}
                      </small>
                      {condition.type === ConditionType.TEXT_CONTAINS ? (
                        <h3>“{condition.textPattern}”</h3>
                      ) : (
                        <>
                          <h3>
                            {condition.filePath}:{condition.lineNumber}
                          </h3>
                          <code>{condition.lastObservedLineContent}</code>
                          <span>
                            Alerts: {lineTriggerNames(condition)} · baseline{" "}
                            {shortSha(condition.baselineCommitSha)} · observed{" "}
                            {shortSha(condition.lastObservedCommitSha)}
                          </span>
                        </>
                      )}
                      {condition.note ? (
                        <p className="condition-note">Note: {condition.note}</p>
                      ) : null}
                    </div>
                    <div className="condition-activity">
                      {condition.notifications[0] ? (
                        <>
                          <strong>
                            {condition.notifications[0].status === "SENT" &&
                            condition.notifications[0].sentAt ? (
                              <LocalSentAt
                                sentAt={condition.notifications[0].sentAt.toISOString()}
                              />
                            ) : (
                              condition.notifications[0].status
                            )}
                          </strong>
                          <span>
                            {condition.notifications[0].eventTitle}
                          </span>
                        </>
                      ) : (
                        <span>No matches yet</span>
                      )}
                    </div>
                    <div className="condition-actions">
                      <EditConditionDialog>
                        {condition.type === ConditionType.TEXT_CONTAINS ? (
                          <TextConditionForm
                            action={`/api/subscriptions/${id}/conditions/${condition.id}`}
                            eventType={event.type}
                            initialValues={{ textPattern: condition.textPattern, note: condition.note }}
                          />
                        ) : (
                          <LineConditionForm
                            action={`/api/subscriptions/${id}/conditions/${condition.id}`}
                            eventType={event.type}
                            repositoryOwner={subscription.repository.owner}
                            repositoryName={subscription.repository.name}
                            initialValues={{
                              filePath: condition.filePath,
                              lineNumber: condition.lineNumber,
                              note: condition.note,
                              notifyOnRemoved: condition.notifyOnRemoved,
                              notifyOnMoved: condition.notifyOnMoved,
                              notifyOnChanged: condition.notifyOnChanged,
                            }}
                          />
                        )}
                      </EditConditionDialog>
                      <form
                        action={`/api/subscriptions/${id}/conditions/${condition.id}/delete`}
                        method="post"
                      >
                        <button
                          className="icon-button"
                          type="submit"
                          aria-label="Remove condition"
                          title="Remove condition"
                        >
                          ×
                        </button>
                      </form>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="event-empty">
                <span aria-hidden="true">＋</span>
                <p>
                  No conditions yet. Add one to decide when this event should
                  email you.
                </p>
              </div>
            )}
          </section>
        ))}

        <section className="danger-zone">
          <div>
            <h2>Remove subscription</h2>
            <p>Stops monitoring this repository for your account.</p>
          </div>
          <form action={`/api/subscriptions/${id}/delete`} method="post">
            <button className="button button-danger" type="submit">
              Remove repository
            </button>
          </form>
        </section>
      </main>
    </>
  );
}

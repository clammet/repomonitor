import { ConditionNoteField } from "./condition-note-field";

type TextConditionFormProps = {
  action: string;
  eventType: string;
  initialValues?: { textPattern: string | null; note: string | null };
};

export function TextConditionForm({
  action,
  eventType,
  initialValues,
}: TextConditionFormProps) {
  return (
    <form action={action} method="post">
      <input type="hidden" name="eventType" value={eventType} />
      <input type="hidden" name="conditionType" value="TEXT_CONTAINS" />
      <strong>Text contains</strong>
      <p>Search messages, release notes, paths, and available diffs.</p>
      <label>
        Text to match
        <input
          name="textPattern"
          placeholder="breaking change"
          required
          maxLength={500}
          defaultValue={initialValues?.textPattern ?? ""}
        />
      </label>
      <ConditionNoteField note={initialValues?.note} />
      <button className="button button-primary button-small" type="submit">
        {initialValues ? "Save changes" : "Add text condition"}
      </button>
    </form>
  );
}

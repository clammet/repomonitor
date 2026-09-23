export function ConditionNoteField({ note }: { note?: string | null }) {
  return (
    <label className="condition-note-field">
      Note (optional)
      <textarea name="note" rows={2} maxLength={2000} defaultValue={note ?? ""} />
      <small>A reminder for yourself, included in matching notification emails.</small>
    </label>
  );
}

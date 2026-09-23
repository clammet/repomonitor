"use client";

import { useId, useRef, useState, type ReactNode } from "react";

export function EditConditionDialog({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [formVersion, setFormVersion] = useState(0);

  function open() {
    dialogRef.current?.showModal();
  }

  return (
    <>
      <button className="button button-small" type="button" onClick={open}>
        Edit
      </button>
      <dialog
        className="condition-dialog"
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={() => setFormVersion((version) => version + 1)}
      >
        <h2 id={titleId}>Edit condition</h2>
        <div key={formVersion}>{children}</div>
        <button className="button button-small" type="button" onClick={() => dialogRef.current?.close()}>
          Cancel
        </button>
      </dialog>
    </>
  );
}

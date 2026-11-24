// Visible required-field markers (app/components/ui/required.tsx). They are hidden from assistive
// technology: the native required attribute gives the semantics.
export function Req() {
  return (
    <span className="req" aria-hidden="true">
      {" "}
      *
    </span>
  );
}

export function RequiredNote({ children = "required" }) {
  return (
    <p className="req-note" aria-hidden="true">
      <span className="req">*</span> {children}
    </p>
  );
}

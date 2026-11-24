export function Req() {
  return (
    <span className="sb-req" aria-hidden="true">
      {" "}
      *
    </span>
  );
}
export function RequiredNote({ children = "Required" }) {
  return (
    <p className="sb-req-note" aria-hidden="true">
      <span className="sb-req">*</span> {children}
    </p>
  );
}

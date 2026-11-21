import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { MentionInput } from "./mention-input";
import type { RichCommentInput } from "./rich-comment-input";

type Rich = typeof RichCommentInput;

// The comment field. The plain text field works at once; the editor with formats replaces it when its code
// arrives. Both read and write the same text and mention ranges, so no typed text is lost.
export function CommentInput(props: ComponentProps<typeof MentionInput>): ReactNode {
  const holder = useRef<HTMLDivElement | null>(null);
  const [rich, setRich] = useState<{ Editor: Rich; focus: boolean } | null>(null);
  useEffect(() => {
    // The server build must not hold the editor code.
    if (import.meta.env.SSR) return;
    let live: boolean = true;
    import("./rich-comment-input")
      .then((module): void => {
        if (!live) return;
        const focus: boolean = holder.current?.contains(document.activeElement) ?? false;
        setRich({ Editor: module.RichCommentInput, focus });
      })
      .catch(reportError);
    return () => {
      live = false;
    };
  }, []);
  return (
    <div ref={holder} className="comment-input">
      {rich ? <rich.Editor {...props} focusOnMount={rich.focus} /> : <MentionInput {...props} />}
    </div>
  );
}

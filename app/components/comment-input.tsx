import { useRef, useSyncExternalStore, type ComponentProps, type ReactNode, type RefObject } from "react";
import { MentionInput } from "./mention-input";
import type { RichCommentInput } from "./rich-comment-input";

type Rich = typeof RichCommentInput;

// The editor code loads one time for the page. Each comment field hears when it arrives.
let editor: Rich | null = null;
let loading: boolean = false;
const waiting = new Set<() => void>();

function load(): void {
  // The server build must not hold the editor code.
  if (import.meta.env.SSR || loading) return;
  loading = true;
  import("./rich-comment-input")
    .then((module): void => {
      editor = module.RichCommentInput;
      for (const tell of waiting) tell();
    })
    .catch(reportError);
}

// The editor for this field, or null while the plain text field stays. A field that has the focus keeps its
// text field until the focus leaves, so no key press is lost.
function useEditor(holder: RefObject<HTMLDivElement | null>): Rich | null {
  const ready = useRef<boolean>(editor !== null);
  return useSyncExternalStore(
    (changed: () => void): (() => void) => {
      const arrived = (): void => {
        const element = holder.current;
        const show = (): void => {
          ready.current = true;
          changed();
        };
        if (element?.contains(document.activeElement)) element.addEventListener("focusout", show, { once: true });
        else show();
      };
      if (editor && !ready.current) arrived();
      waiting.add(arrived);
      load();
      return () => {
        waiting.delete(arrived);
      };
    },
    (): Rich | null => (ready.current ? editor : null),
    (): null => null,
  );
}

// The comment field. The plain text field works at once; the editor with formats replaces it when its code
// arrives. Both read and write the same text and mention ranges, so no typed text is lost.
export function CommentInput(props: ComponentProps<typeof MentionInput>): ReactNode {
  const holder = useRef<HTMLDivElement | null>(null);
  const Editor: Rich | null = useEditor(holder);
  return (
    <div ref={holder} className="comment-input">
      {Editor ? (
        <Editor {...props} />
      ) : (
        <>
          <div className="ed-toolbar-space" />
          <MentionInput {...props} />
        </>
      )}
    </div>
  );
}

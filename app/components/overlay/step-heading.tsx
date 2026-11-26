import type { ReactNode } from "react";

/**
 * The heading of one part of Streamer tools: its step number, when the section has steps, and its title. The number
 * is text, so a screen reader reads "1 Build your overlay". `focusable` lets a script move focus to the heading.
 */
export function StepHeading({
  step,
  id,
  title,
  focusable = false,
}: Readonly<{ step?: number; id: string; title: string; focusable?: boolean }>): ReactNode {
  return (
    <h2 className="ov-step-title" id={id} tabIndex={focusable ? -1 : undefined}>
      {step !== undefined && (
        <>
          <span className="ov-step-num">{step}</span>{" "}
        </>
      )}
      {title}
    </h2>
  );
}

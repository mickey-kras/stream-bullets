import type { ReactNode } from "react";

/**
 * The heading of one step of Overlay control: its number and its title. The number is text, so a screen reader reads
 * "1 Connect channels". `focusable` lets a script move focus to the heading.
 */
export function StepHeading({
  step,
  id,
  title,
  focusable = false,
}: Readonly<{ step: number; id: string; title: string; focusable?: boolean }>): ReactNode {
  return (
    <h2 className="ov-step-title" id={id} tabIndex={focusable ? -1 : undefined}>
      <span className="ov-step-num">{step}</span> {title}
    </h2>
  );
}

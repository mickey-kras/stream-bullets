import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Icon } from "../ui/icon";

type Reaction = -1 | 0 | 1;

/**
 * Like and Dislike with thumbs and a count (item 20), for topics, ideas and polls. A pressed thumb is filled.
 * Poll buttons name the poll for screen readers ("Like poll, 3"), as the mockup does.
 */
export function VoteButtons({
  reaction,
  likes,
  dislikes,
  disabled,
  poll = false,
  onReact,
}: Readonly<{
  reaction: Reaction;
  likes: number;
  dislikes: number;
  disabled: boolean;
  poll?: boolean;
  onReact: (value: Reaction) => void;
}>): ReactNode {
  const button = (value: 1 | -1): ReactNode => {
    const like: boolean = value === 1;
    const pressed: boolean = reaction === value;
    let icon: "thumbs-up" | "thumbs-up-filled" | "thumbs-down" | "thumbs-down-filled" = like
      ? "thumbs-up"
      : "thumbs-down";
    if (pressed) icon = like ? "thumbs-up-filled" : "thumbs-down-filled";
    return (
      <button type="button" disabled={disabled} aria-pressed={pressed} onClick={() => onReact(pressed ? 0 : value)}>
        <Icon name={icon} size={24} />
        <span className="vote-word" aria-hidden={poll || undefined}>
          {t(like ? "entry.like" : "entry.dislike")}
        </span>
        {poll && <span className="sr-only">{t(like ? "poll.like" : "poll.dislike")}, </span>}{" "}
        <b>{like ? likes : dislikes}</b>
      </button>
    );
  };
  return (
    <>
      {button(1)}
      {button(-1)}
    </>
  );
}

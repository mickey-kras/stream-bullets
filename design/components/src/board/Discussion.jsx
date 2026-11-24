import { Children, isValidElement, useRef, useState } from "react";
import { Avatar } from "../core/Avatar.jsx";
import { Icon } from "../core/Icon.jsx";
import { IconButton } from "../core/IconButton.jsx";
import { Select } from "../forms/Select.jsx";

// The discussion of a topic or poll, as in app/components/discussion.tsx and the comment-*.tsx parts. App data,
// fetch and drafts are plain props here.

// The format buttons of app/components/rich-comment-input.tsx, in their order.
const FORMAT_BUTTONS = [
  { icon: "bold", label: "Bold" },
  { icon: "italic", label: "Italic" },
  { icon: "strikethrough", label: "Strikethrough" },
  { icon: "code", label: "Code" },
  { icon: "link", label: "Add link" },
  { icon: "list-bullet", label: "Bulleted list" },
  { icon: "list-number", label: "Numbered list" },
  { icon: "quote", label: "Quote" },
  { icon: "code-block", label: "Code block" },
];

// The rich editor of app/components/rich-comment-input.tsx inside the `.comment-input` holder of
// app/components/comment-input.tsx. The format buttons show their look only; the field is a plain editable box.
function CommentInput({ label, placeholder, disabled, defaultValue, field, onText }) {
  const [empty, setEmpty] = useState(!defaultValue);
  return (
    <div className="comment-input">
      <div className="mention-input rich-input" data-empty={empty} data-disabled={disabled}>
        <div className="ed-toolbar" role="toolbar" aria-label="Text formats">
          {FORMAT_BUTTONS.map(({ icon, label: name }) => (
            <button key={icon} type="button" aria-label={name} title={name} aria-pressed={false} disabled={disabled}>
              <Icon name={icon} size={18} />
            </button>
          ))}
        </div>
        <div
          ref={field}
          className="ed-content comment-text"
          data-composer
          aria-multiline="true"
          aria-label={label}
          aria-required="true"
          aria-disabled={disabled}
          aria-placeholder={placeholder}
          data-placeholder={placeholder}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={(event) => {
            const text = event.currentTarget.innerText.trim();
            setEmpty(text === "");
            onText(text);
          }}
        >
          {defaultValue ? <p>{defaultValue}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function Composer({
  label = "Write a comment",
  placeholder = "Write a comment…",
  postLabel = "Post",
  defaultValue = "",
  viewerPreset = 7,
  viewerUrl,
  disabled = false,
  onChange,
  onPost,
  replyingTo,
  onCancelReply,
}) {
  const field = useRef(null);
  const [text, setText] = useState(defaultValue);
  const form = (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onPost?.(text);
        if (field.current) field.current.textContent = "";
        field.current?.dispatchEvent(new Event("input", { bubbles: true }));
      }}
    >
      <Avatar preset={viewerPreset} url={viewerUrl} />
      <CommentInput
        label={label}
        placeholder={placeholder}
        disabled={disabled}
        defaultValue={defaultValue}
        field={field}
        onText={(value) => {
          setText(value);
          onChange?.(value);
        }}
      />
      <button className="gold" type="submit" disabled={disabled || !text.trim()}>
        <Icon name="send" size={18} />
        {postLabel}
      </button>
    </form>
  );
  if (!replyingTo) return form;
  return (
    <>
      <div className="replying">
        Replying to {replyingTo}{" "}
        <button type="button" className="small-button" aria-label="Cancel reply" onClick={onCancelReply}>
          <Icon name="close" size={16} />
          Cancel
        </button>
      </div>
      {form}
    </>
  );
}

function ReportButton({ name, onReport }) {
  return (
    <button type="button" aria-label={`Report comment by ${name}`} onClick={onReport}>
      <Icon name="flag" size={16} />
      Report
    </button>
  );
}

function DeleteButton({ onDelete }) {
  return (
    <button type="button" aria-label="Delete comment" onClick={onDelete}>
      <Icon name="trash" size={16} />
      Delete
    </button>
  );
}

function CommentActions({
  name,
  likes,
  liked,
  disabled,
  canEdit,
  canReport,
  canDelete,
  onLike,
  onReply,
  onEdit,
  onReport,
  onDelete,
}) {
  const report = canReport && <ReportButton name={name} onReport={onReport} />;
  const remove = canDelete && <DeleteButton onDelete={onDelete} />;
  return (
    <div className="comment-actions">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={liked}
        aria-label={`Like comment by ${name}`}
        onClick={onLike}
      >
        <Icon name={liked ? "thumbs-up-filled" : "thumbs-up"} size={16} />
        Like <span className="count">{likes}</span>
      </button>
      <button type="button" disabled={disabled} onClick={onReply}>
        <Icon name="reply" size={16} />
        Reply
      </button>
      {canEdit && (
        <button type="button" onClick={onEdit}>
          Edit
        </button>
      )}
      {canDelete && canReport ? (
        <details className="more-actions">
          <summary aria-label={`More actions for comment by ${name}`}>
            <Icon name="more" size={18} />
          </summary>
          <div className="more-menu">
            {report}
            {remove}
          </div>
        </details>
      ) : (
        (remove || report) && (
          <span className="comment-direct">
            {report}
            {remove}
          </span>
        )
      )}
    </div>
  );
}

// The text of a comment: a string becomes paragraphs, as the comment Markdown of the app renders plain text.
function CommentText({ children }) {
  return (
    <div className="comment-text">
      {typeof children === "string"
        ? children.split(/\n{2,}/u).map((paragraph, index) => <p key={index}>{paragraph}</p>)
        : children}
    </div>
  );
}

// "Answered" mark of app/components/comment-answer.tsx. `answered` is true, or { title, date, href } of the stream.
function AnswerLine({ answered, owner, onToggleAnswered }) {
  const stream = answered && typeof answered === "object" ? answered : null;
  return (
    <div className="comment-answer">
      {answered && (
        <p className="comment-answer-line">
          <Icon name="check" size={14} />
          {stream ? (
            <a href={stream.href} target="_blank" rel="noopener noreferrer">
              Answered on stream: {stream.title}, {stream.date}
            </a>
          ) : (
            "Answered"
          )}
        </p>
      )}
      {owner && (
        <div className="comment-answer-controls">
          <button type="button" className="text-button" onClick={onToggleAnswered}>
            {answered ? "Remove the answered mark" : "Mark as answered"}
          </button>
          <p className="form-error" role="alert" />
        </div>
      )}
    </div>
  );
}

/**
 * One comment, as the CommentArticle of app/components/discussion.tsx.
 * `translation` is { from, original }: the children are the translated text and the button shows the original.
 * `edited` is true (the "Edited" note) or "history" (the button that opens the earlier texts, for the page owner).
 */
export function Comment({
  id,
  name,
  preset = 14,
  url,
  time = "Just now",
  dateTime,
  children,
  likes = 0,
  liked = false,
  disabled = false,
  canEdit = false,
  report = true,
  reported = false,
  canDelete = false,
  replyTo,
  answered = false,
  owner = false,
  translation,
  edited = false,
  removed = false,
  onLike,
  onReply,
  onEdit,
  onReport,
  onDelete,
  onToggleAnswered,
  onHistory,
}) {
  const [original, setOriginal] = useState(false);
  if (removed)
    return (
      <article className="comment removed" id={id && `cm-${id}`} aria-label="Comment removed">
        <span className="removed-avatar" aria-hidden="true">
          <Icon name="eye-off" size={18} />
        </span>
        <div className="comment-body">
          <p className="removed-note">Comment removed</p>
        </div>
      </article>
    );
  const shown = translation && original ? translation.original : children;
  return (
    <article className="comment" tabIndex={-1} id={id && `cm-${id}`}>
      <Avatar preset={preset} url={url} />
      <div className="comment-body">
        <div className="comment-meta">
          <strong>{name}</strong>
          <time dateTime={dateTime}>{time}</time>
          {reported && (
            <span className="reported-note">
              <Icon name="flag" size={14} />
              Reported
            </span>
          )}
        </div>
        {replyTo && (
          <a className="replying reply-mention" href={`#cm-${replyTo.id ?? ""}`}>
            <Icon name="reply" size={16} />
            Reply to {replyTo.name ?? replyTo}
          </a>
        )}
        <CommentText>{shown}</CommentText>
        {translation && (
          <p className="comment-translation">
            {!original && <span>{translation.from ? `Translated from ${translation.from}` : "Translated"}</span>}
            <button type="button" aria-pressed={original} onClick={() => setOriginal(!original)}>
              <Icon name="translate" size={16} />
              {original ? "Show translation" : "Show original"}
            </button>
          </p>
        )}
        {edited === "history" && (
          <button
            type="button"
            className="text-button comment-history-button"
            aria-label="Show the earlier texts of this comment"
            onClick={onHistory}
          >
            Edited
          </button>
        )}
        {edited === true && <span className="muted">Edited</span>}
        {(answered || owner) && <AnswerLine answered={answered} owner={owner} onToggleAnswered={onToggleAnswered} />}
        <div>
          <CommentActions
            name={name}
            likes={likes}
            liked={liked}
            disabled={disabled}
            canEdit={canEdit}
            canReport={report && !reported && !disabled}
            canDelete={canDelete}
            onLike={onLike}
            onReply={onReply}
            onEdit={onEdit}
            onReport={onReport}
            onDelete={onDelete}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * A comment and its replies, as the Thread of app/components/discussion.tsx. `comment` is the first <Comment>,
 * `replies` the <Comment> elements under it. `more` is the count of replies that are not loaded yet.
 */
export function Thread({
  id = "1",
  comment,
  replies = [],
  author = "",
  more = 0,
  onMore,
  replyBox,
  defaultHidden = false,
}) {
  const [hidden, setHidden] = useState(defaultHidden);
  const count = replies.length + more;
  const listId = `replies-${id}`;
  const showLabel = `Show ${count} ${count === 1 ? "reply" : "replies"}`;
  return (
    <li className={`thread${count ? " has-replies" : ""}`}>
      {comment}
      {count > 0 && (
        <button
          type="button"
          className="thread-toggle"
          aria-expanded={!hidden}
          aria-controls={listId}
          onClick={() => setHidden(!hidden)}
        >
          <Icon name={hidden ? "chevron-right" : "chevron-down"} size={16} />
          {hidden ? showLabel : `Hide replies (${count})`}
        </button>
      )}
      {(count > 0 || replyBox) && (
        <ul className="replies" id={listId} hidden={hidden} aria-label={`Replies to ${author}`}>
          {replies.map((reply, index) => (
            <li key={reply.key ?? index}>{reply}</li>
          ))}
          {more > 0 && (
            <li className="thread-more">
              <button
                type="button"
                className="text-button"
                aria-expanded={false}
                aria-controls={listId}
                onClick={onMore}
              >
                <Icon name="chevron-down" size={16} />
                {`View ${more} more ${more === 1 ? "reply" : "replies"}`}
              </button>
            </li>
          )}
          {replyBox && !hidden && <li className="inline-reply">{replyBox}</li>}
        </ul>
      )}
    </li>
  );
}

/**
 * The discussion block: the head with the sort and refresh controls, the composer, and the thread list.
 * Children are <Thread> or <Comment> elements; a <Composer> child takes the place of the composer.
 */
export function Discussion({
  id = "1",
  title = "Discussion",
  sort,
  defaultSort = "newest",
  onSort,
  onRefresh,
  signedIn = true,
  onSignIn,
  composer,
  empty = "Start the conversation. What do you think?",
  hasMore = false,
  onLoadMore,
  children,
  className = "",
}) {
  let slot = composer;
  const items = [];
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === Composer) slot = child;
    else if (isValidElement(child) && child.type === Comment)
      items.push(
        <li key={child.key ?? items.length} className="thread">
          {child}
        </li>,
      );
    else if (child !== null && child !== undefined && child !== false) items.push(child);
  });
  return (
    <section className={`discussion ${className}`.trim()} aria-labelledby={`discussion-${id}`}>
      <div className="discussion-head">
        <h3 id={`discussion-${id}`}>{title}</h3>
        <Select
          className="comment-sort"
          label="Sort comments"
          value={sort}
          defaultValue={defaultSort}
          onValueChange={onSort}
          options={[
            { value: "newest", label: "Newest" },
            { value: "top", label: "Top" },
          ]}
        />
        <IconButton label="Refresh comments" icon="refresh" onClick={onRefresh} />
      </div>
      {signedIn ? (
        (slot ?? <Composer />)
      ) : (
        <p className="join-discussion">
          <button type="button" className="gold" onClick={onSignIn}>
            <Icon name="comment" size={18} />
            Sign in to comment
          </button>
        </p>
      )}
      <p className="form-error" role="alert" />
      {items.length === 0 && <p className="empty">{empty}</p>}
      <ul className="thread-list" aria-label="Comments">
        {items}
      </ul>
      {hasMore && (
        <button type="button" className="load-more" onClick={onLoadMore}>
          Load more comments
        </button>
      )}
    </section>
  );
}

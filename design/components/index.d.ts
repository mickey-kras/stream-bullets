// Types of the public parts in src/index.js, for documentation.
import type {
  ButtonHTMLAttributes,
  ComponentType,
  CSSProperties,
  InputHTMLAttributes,
  JSX,
  MouseEventHandler,
  NamedExoticComponent,
  ReactElement,
  ReactNode,
} from "react";

// Core

/** Number of avatar presets (0..17). */
export declare const AVATAR_PRESET_COUNT: number;
/** The default preset: 14, Space explorer. */
export declare const DEFAULT_AVATAR_PRESET: number;
/** Preset order of the avatar picker: the default first, then three rows of six. */
export declare const AVATAR_ORDER: readonly number[];
/** English preset names, indexed by preset. */
export declare const AVATAR_NAMES: readonly string[];
/** Background style of a preset portrait: a sprite position (0..15) or a separate image (16, 17). */
export function portraitStyle(preset: number): CSSProperties;

export interface AvatarProps {
  /** Uploaded picture URL; wins over the preset. Default null. */
  url?: string | null;
  /** Preset 0..17; anything else shows the default Space explorer. Default null. */
  preset?: number | null;
  /** 48, 32 or 20 use the app classes; any other number sets an inline width and height. */
  size?: number;
  /** Extra classes. Default "". */
  className?: string;
}
/** Decorative avatar picture (aria-hidden, empty alt); never initials. */
export function Avatar(props: AvatarProps): JSX.Element;

export interface StreamerLogoProps {
  /** Page logo URL; first choice. Default null. */
  logo?: string | null;
  /** Owner upload URL; second choice. Default null. */
  avatar?: string | null;
  /** Owner preset; third choice before the default. Default null. */
  ownerAvatarPreset?: number | null;
  /** Same as Avatar size. */
  size?: number;
  /** Extra classes. Default "". */
  className?: string;
}
/** Page picture with the app fallback chain. */
export function StreamerLogo(props: StreamerLogoProps): JSX.Element;

export type ButtonVariant = "default" | "gold" | "danger" | "small" | "text" | "link" | "secondary";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** App button class; "secondary" needs the .landing-actions container. Default "default". */
  variant?: ButtonVariant;
  /** Icon before the text. */
  icon?: IconName;
  /** Icon after the text. */
  iconEnd?: IconName;
  /** Icon size. Default 16 for "small", else 18. */
  iconSize?: 14 | 16 | 18 | 20 | 24 | 40;
  /** Sets aria-pressed for toggle buttons. */
  pressed?: boolean;
  /** Default "button". */
  type?: "button" | "submit" | "reset";
  /** Extra classes. Default "". */
  className?: string;
  children?: ReactNode;
}
/** Native button with the app classes. */
export function Button(props: ButtonProps): JSX.Element;

/** Names of the custom glyphs of app/components/ui/icon-paths.tsx. */
export type LocalIconName =
  | "topics"
  | "polls"
  | "schedule"
  | "about"
  | "community"
  | "google"
  | "twitch"
  | "tiktok"
  | "instagram"
  | "check"
  | "search"
  | "refresh"
  | "reply"
  | "trash"
  | "flag"
  | "upload"
  | "download"
  | "zoom-in"
  | "zoom-out"
  | "chevron-down"
  | "chevron-up"
  | "thumbs-up"
  | "thumbs-up-filled"
  | "thumbs-down"
  | "thumbs-down-filled"
  | "comment"
  | "cat-tech"
  | "cat-gaming"
  | "cat-creative"
  | "cat-chatting"
  | "search-none"
  | "tilt"
  | "play"
  | "youtube"
  | "kick"
  | "discord"
  | "heart"
  | "gift"
  | "star"
  | "palette"
  | "megaphone"
  | "more"
  | "grip"
  | "up"
  | "down";
/** Semantic names mapped to Lucide icons, as in app/components/ui/icon.tsx. */
export type LucideIconName =
  | "streamers"
  | "your-page"
  | "admin"
  | "home"
  | "user"
  | "pencil"
  | "mic"
  | "data"
  | "sign-in"
  | "sign-out"
  | "at-sign"
  | "plus"
  | "minus"
  | "close"
  | "send"
  | "save"
  | "link"
  | "bold"
  | "italic"
  | "strikethrough"
  | "list-bullet"
  | "list-number"
  | "quote"
  | "code"
  | "code-block"
  | "copy"
  | "external"
  | "image"
  | "crop"
  | "reset"
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "arrow-right"
  | "sort-top"
  | "sort-new"
  | "poll-choice"
  | "poll-binary"
  | "timer"
  | "live"
  | "eye"
  | "eye-off"
  | "stop"
  | "lock"
  | "overlay"
  | "wifi"
  | "wifi-off"
  | "requests"
  | "key"
  | "approve"
  | "reject"
  | "mail"
  | "globe"
  | "translate"
  | "shield-check"
  | "success"
  | "error"
  | "warning"
  | "pending"
  | "rejected"
  | "idea"
  | "compass"
  | "privacy"
  | "terms"
  | "zap"
  | "heart"
  | "megaphone";
/** Every icon name; a custom glyph wins when both sets have the name. */
export type IconName = LocalIconName | LucideIconName;
/** Icon sizes of the app CSS (icon-<size> class). */
/** Props that the design system passes to a Lucide icon. */
export interface LucideIconProps {
  className?: string;
  size?: number | string;
  strokeWidth?: number | string;
  "aria-hidden"?: boolean | "true" | "false";
  focusable?: boolean | "true" | "false";
}

/** The custom glyphs: name -> SVG children. */
export declare const LOCAL_ICONS: Readonly<Record<LocalIconName, ReactElement>>;
/** Semantic name -> Lucide icon component. */
export declare const LUCIDE_ICONS: Readonly<Record<LucideIconName, ComponentType<LucideIconProps>>>;
/** Every icon name, custom glyphs first. */
export declare const ICON_NAMES: readonly IconName[];

export interface IconProps {
  /** Icon name; an unknown name renders nothing. */
  name: IconName;
  /** Default 18. */
  size?: 14 | 16 | 18 | 20 | 24 | 40;
  /** Extra classes. Default "". */
  className?: string;
}
/** Decorative currentColor icon (aria-hidden); label the control instead. */
export function Icon(props: IconProps): JSX.Element | null;

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name; also the tooltip unless title is set. */
  label: string;
  /** Icon name. */
  icon: IconName;
  /** Default 20. */
  iconSize?: 14 | 16 | 18 | 20 | 24 | 40;
  /** A larger value plays the spin animation again; 0 turns it off. Default 0. */
  spin?: number;
  /** Tooltip. Default label. */
  title?: string;
  /** Default "button". */
  type?: "button" | "submit" | "reset";
  /** Extra classes. Default "". */
  className?: string;
}
/** Named icon button: 40px target, 44px on phones. */
export function IconButton(props: IconButtonProps): JSX.Element;

/** Returns the URL of a file in design/assets/, e.g. "Logos/stream-bullets.svg". */
export function assetUrl(path: string): string;
/** Asset paths of the wordmark and the icon mark. */
export declare const LOGO_SRC: { readonly full: string; readonly icon: string };

export interface LogoProps {
  /** "site": header home link (wordmark, icon on phones); "full"/"icon": the image only. Default "site". */
  kind?: "site" | "full" | "icon";
  /** Link target of kind "site". Default "/". */
  href?: string;
  /** Accessible name of kind "site". Default "Home". */
  label?: string;
  /** Image height of kind "full"/"icon"; width follows. */
  height?: number;
  /** Extra classes. Default "". */
  className?: string;
  /** Click handler of kind "site". */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}
/** The brand images of the app. */
export function Logo(props: LogoProps): JSX.Element;

// Forms

export interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Default "radio". */
  type?: "radio" | "checkbox";
  /** Row text. */
  label: ReactNode;
  /** Hint under the label. */
  help?: ReactNode;
  /** Extra classes on the label. Default "". */
  className?: string;
}
/** Radio or checkbox row with an optional hint. */
export function Choice(props: ChoiceProps): JSX.Element;

/** Visible required marker " *", hidden from assistive technology. Takes no props. */
export function Req(): JSX.Element;

export interface RequiredNoteProps {
  /** Note text. Default "required". */
  children?: ReactNode;
}
/** "* required" note, hidden from assistive technology. */
export function RequiredNote(props: RequiredNoteProps): JSX.Element;

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "name"> {
  /** "topics": topic board search; "streamers": directory search in a <search> landmark. Default "topics". */
  variant?: "topics" | "streamers";
  /** Hidden label. Default "Search topics" or "Search streamers". */
  label?: string;
  /** Default "Search topics…" or "Search by name or @handle…". */
  placeholder?: string;
  /** Submit button text. Default "Search". */
  buttonLabel?: ReactNode;
  /** Default 100 (topics) or 60 (streamers). */
  maxLength?: number;
  /** Input id. Default a generated id. */
  id?: string;
  /** Gets the trimmed query on submit. */
  onSearch?: (query: string) => void;
  /** Extra classes. Default "". */
  className?: string;
}
/** Search form with a Search submit button. */
export function SearchField(props: SearchFieldProps): JSX.Element;

export interface SelectOption {
  /** Option value. */
  value: string;
  /** Option text. */
  label: ReactNode;
  /** Icon before the text. */
  icon?: IconName;
}
export interface SelectProps {
  /** Trigger id. */
  id?: string;
  /** The options. */
  options: readonly SelectOption[];
  /** Controlled value. */
  value?: string;
  /** Uncontrolled start value. */
  defaultValue?: string;
  /** Gets the chosen value. */
  onValueChange?: (value: string) => void;
  /** Adds a hidden form input with this name. */
  name?: string;
  /** Accessible name when labelledBy is not set. */
  label?: string;
  /** Id of the element that names the select. */
  labelledBy?: string;
  /** Text when nothing is chosen. */
  placeholder?: ReactNode;
  /** Default false. */
  required?: boolean;
  /** Default false. */
  disabled?: boolean;
  /** Extra classes. Default "". */
  className?: string;
}
/** Radix select-only combobox; inside a modal dialog the list mounts in that dialog. */
export function Select(props: SelectProps): JSX.Element;

export interface TabsItem {
  /** Item value. */
  value: string;
  /** Button text. */
  label: ReactNode;
}
export interface TabsProps {
  /** The buttons. */
  items: readonly TabsItem[];
  /** Controlled value. */
  value?: string;
  /** Uncontrolled start value. Default the first item. */
  defaultValue?: string;
  /** Gets the pressed value. */
  onValueChange?: (value: string) => void;
  /** Hidden legend of the fieldset. */
  label?: ReactNode;
  /** Classes after "tabs". Default "sort-switch". */
  className?: string;
}
/** Segmented toggle: a fieldset of pressed buttons. */
export function Tabs(props: TabsProps): JSX.Element;

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement | HTMLTextAreaElement>, "size" | "required" | "id"> {
  /** Label text. */
  label: ReactNode;
  /** Hint under the field. */
  help?: ReactNode;
  /** A string shows the error under the field; any truthy value sets aria-invalid. */
  error?: string | boolean;
  /** Adds the required attribute and marker. Default false. */
  required?: boolean;
  /** Renders a textarea. Default false. */
  multiline?: boolean;
  /** Textarea rows. Default 4. */
  rows?: number;
  /** Field id. Default a generated id. */
  id?: string;
  /** Label classes; "field" for the sheet layout. Default "". */
  className?: string;
  /** Label text classes; "field-label" for the sheet layout. Default "". */
  labelClassName?: string;
}
/** Labelled input or textarea. */
export function TextField(props: TextFieldProps): JSX.Element;

// Feedback

export interface OwnerNoticeProps {
  /** "active" renders nothing. Default "frozen". */
  status?: "frozen" | "suspended" | "active";
  /** Notice text. Default the owner text of the status. */
  children?: ReactNode;
}
/** Owner moderation notice of the account menu and the edit dialog. */
export function OwnerNotice(props: OwnerNoticeProps): JSX.Element | null;

export interface BannerProps {
  /** Default "frozen". */
  tone?: "frozen" | "suspended";
  /** Who reads it. Default "viewer" when frozen, "owner" when suspended. */
  role?: "viewer" | "owner" | "admin";
  /** Banner text. Default the text of tone and role. */
  children?: ReactNode;
  /** Owner button text. Default "Appeal / contact us". */
  appealLabel?: ReactNode;
  /** Owner button click. */
  onAppeal?: MouseEventHandler<HTMLButtonElement>;
  /** Admin button text on frozen pages. Default "Unfreeze". */
  unfreezeLabel?: ReactNode;
  /** Admin button click. */
  onUnfreeze?: MouseEventHandler<HTMLButtonElement>;
  /** Admin link text. Default "Open moderation". */
  moderationLabel?: ReactNode;
  /** Admin link target. Default "/admin?view=pages". */
  moderationHref?: string;
}
/** Moderation banner of a frozen or suspended page. */
export function Banner(props: BannerProps): JSX.Element;

export interface DialogProps {
  /** Default true. */
  open?: boolean;
  /** Gets the next open state. */
  onOpenChange?: (open: boolean) => void;
  /** Dialog title; focused on open. */
  title: ReactNode;
  /** Description under the title. */
  description?: ReactNode;
  children?: ReactNode;
  /** Primary actions, after Cancel. */
  actions?: ReactNode;
  /** Shows the Cancel button. Default true. */
  cancel?: boolean;
  /** Default "Cancel". */
  cancelLabel?: ReactNode;
  /** Cancel button click. */
  onCancel?: MouseEventHandler<HTMLButtonElement>;
  /** Close button name. Default "Close dialog". */
  closeLabel?: string;
  /** In page flow for previews: no portal, backdrop or focus trap. Default false. */
  inline?: boolean;
  /** Gives focus back to the opener on close. Default true. */
  returnFocus?: boolean;
  /** Extra classes on the panel. Default "". */
  className?: string;
}
/** The app dialog: a Radix modal with a title row and sticky actions. */
export function Dialog(props: DialogProps): JSX.Element;

export interface EmptyStateProps {
  /** Heading. */
  title: ReactNode;
  /** Icon above the heading, at 40px. */
  icon?: IconName;
  /** Text under the heading. */
  children?: ReactNode;
  /** Call to action under the text. */
  action?: ReactNode;
}
/** Empty state of a list or view. */
export function EmptyState(props: EmptyStateProps): JSX.Element;

export interface LivePillProps {
  /** Default "Scheduled now". */
  label?: ReactNode;
  /** The running event, for screen readers. */
  title?: ReactNode;
  /** Default "?view=schedule". */
  href?: string;
  /** Extra classes. Default "". */
  className?: string;
}
/** Live badge next to the streamer name; links to the schedule. */
export function LivePill(props: LivePillProps): JSX.Element;

export interface OnAirTickerProps {
  /** The running event. */
  title: ReactNode;
  /** Default "Scheduled now". */
  label?: ReactNode;
  /** Default "?view=schedule". */
  href?: string;
}
/** On-air strip under the streamer header. */
export function OnAirTicker(props: OnAirTickerProps): JSX.Element;

export interface SheetProps {
  /** Default true. */
  open?: boolean;
  /** Gets the next open state. */
  onOpenChange?: (open: boolean) => void;
  /** Sheet title; focused on open. */
  title: ReactNode;
  /** Hidden description. */
  description?: ReactNode;
  /** Shows the Back step button. */
  onBack?: MouseEventHandler<HTMLButtonElement>;
  /** Default "Back". */
  backLabel?: ReactNode;
  /** Scrolling body. */
  children?: ReactNode;
  /** Docked actions, after Cancel. */
  actions?: ReactNode;
  /** Shows Cancel with the actions. Default true. */
  cancel?: boolean;
  /** Default "Cancel". */
  cancelLabel?: ReactNode;
  /** Cancel button click. */
  onCancel?: MouseEventHandler<HTMLButtonElement>;
  /** Close button name. Default "Close dialog". */
  closeLabel?: string;
  /** Keeps a centered card on phones. Default false. */
  short?: boolean;
  /** data-sheet value. */
  name?: string;
  /** In page flow for previews. Default false. */
  inline?: boolean;
  /** Extra classes on the panel. Default "". */
  className?: string;
}
/** Long dialog with a sticky head, scrolling body and docked actions; full screen on phones. */
export function Sheet(props: SheetProps): JSX.Element;

/** Minimum duration of a toast with an action, in ms (10000). */
export declare const ACTION_TOAST_MS: number;
/** Toast duration in ms: 5000 + 60 per character, at least ACTION_TOAST_MS with an action. */
export function toastDuration(message: string, hasAction: boolean): number;

export interface ToastAction {
  /** Button text and alt text. */
  label: string;
  /** Button click. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}
export interface ToastProps {
  /** Toast text. */
  message: string;
  /** "error" is a foreground toast. Default "status". */
  tone?: "status" | "error";
  /** Action button, e.g. Undo. */
  action?: ToastAction;
  /** Fixed app viewport with the timed duration; else in flow and untimed. Default false. */
  floating?: boolean;
  /** Default true. */
  open?: boolean;
  /** Gets the next open state. */
  onOpenChange?: (open: boolean) => void;
  /** Duration in ms. Default toastDuration() when floating, else Infinity. */
  duration?: number;
  /** Region name. Default "Notifications". */
  regionLabel?: string;
  /** Extra classes. Default "". */
  className?: string;
}
/** One Radix toast in its own viewport. */
export function Toast(props: ToastProps): JSX.Element;

// Board

/** Icon of a stored topic category; unknown categories get "cat-tech". */
export function categoryIcon(category: string): "cat-tech" | "cat-gaming" | "cat-creative" | "cat-chatting";

export interface CategoryProps {
  /** Icon. Default categoryIcon(category). */
  icon?: IconName;
  /** Stored category. Default "Tech & setups". */
  category?: string;
  /** Plate text. Default category. */
  children?: ReactNode;
  /** Extra classes. Default "". */
  className?: string;
}
/** Category plate of a topic. */
export function Category(props: CategoryProps): JSX.Element;

export interface ComposerProps {
  /** Field name. Default "Write a comment". */
  label?: string;
  /** Default "Write a comment…". */
  placeholder?: string;
  /** Submit text. Default "Post". */
  postLabel?: ReactNode;
  /** Start text. Default "". */
  defaultValue?: string;
  /** Viewer avatar preset. Default 7. */
  viewerPreset?: number | null;
  /** Viewer avatar URL. */
  viewerUrl?: string | null;
  /** Default false. */
  disabled?: boolean;
  /** Gets the trimmed text on each input. */
  onChange?: (text: string) => void;
  /** Gets the text on submit. */
  onPost?: (text: string) => void;
  /** Shows "Replying to …" with a Cancel button. */
  replyingTo?: ReactNode;
  /** Cancel reply click. */
  onCancelReply?: MouseEventHandler<HTMLButtonElement>;
}
/** Comment composer: avatar, rich input look and Post button. */
export function Composer(props: ComposerProps): JSX.Element;

export interface CommentStream {
  /** Stream title. */
  title: string;
  /** Stream date text. */
  date: string;
  /** Stream link. */
  href: string;
}
export interface CommentTranslation {
  /** Source language name. */
  from?: string;
  /** Original text. */
  original: ReactNode;
}
export interface CommentProps {
  /** Comment id; the element id is "cm-<id>". */
  id?: string;
  /** Author name. */
  name: string;
  /** Author preset. Default 14. */
  preset?: number | null;
  /** Author avatar URL. */
  url?: string | null;
  /** Time text. Default "Just now". */
  time?: ReactNode;
  /** Machine-readable time. */
  dateTime?: string;
  /** Text; a string becomes paragraphs. */
  children?: ReactNode;
  /** Default 0. */
  likes?: number;
  /** Default false. */
  liked?: boolean;
  /** Disables Like and Reply and hides Report. Default false. */
  disabled?: boolean;
  /** Shows Edit. Default false. */
  canEdit?: boolean;
  /** Shows Report. Default true. */
  report?: boolean;
  /** Shows the Reported note. Default false. */
  reported?: boolean;
  /** Shows Delete. Default false. */
  canDelete?: boolean;
  /** The replied comment: a name, or its id and name. */
  replyTo?: string | { id: string; name: string };
  /** true, or the stream it was answered on. Default false. */
  answered?: boolean | CommentStream;
  /** Shows the answered toggle. Default false. */
  owner?: boolean;
  /** Children are the translation; adds the Show original toggle. */
  translation?: CommentTranslation;
  /** true: "Edited" note; "history": button for the earlier texts. Default false. */
  edited?: boolean | "history";
  /** Shows the removed placeholder. Default false. */
  removed?: boolean;
  onLike?: MouseEventHandler<HTMLButtonElement>;
  onReply?: MouseEventHandler<HTMLButtonElement>;
  onEdit?: MouseEventHandler<HTMLButtonElement>;
  onReport?: MouseEventHandler<HTMLButtonElement>;
  onDelete?: MouseEventHandler<HTMLButtonElement>;
  onToggleAnswered?: MouseEventHandler<HTMLButtonElement>;
  onHistory?: MouseEventHandler<HTMLButtonElement>;
}
/** One comment with its actions. */
export function Comment(props: CommentProps): JSX.Element;

export interface ThreadProps {
  /** Thread id for the replies list id. Default "1". */
  id?: string;
  /** The first <Comment>. */
  comment: ReactNode;
  /** <Comment> elements under it. Default []. */
  replies?: readonly ReactElement[];
  /** Author name of the replies list label. Default "". */
  author?: string;
  /** Replies not loaded yet. Default 0. */
  more?: number;
  /** View more click. */
  onMore?: MouseEventHandler<HTMLButtonElement>;
  /** Inline reply composer. */
  replyBox?: ReactNode;
  /** Starts with the replies hidden. Default false. */
  defaultHidden?: boolean;
}
/** A comment and its collapsible replies. */
export function Thread(props: ThreadProps): JSX.Element;

export interface DiscussionProps {
  /** Heading id suffix. Default "1". */
  id?: string;
  /** Heading. Default "Discussion". */
  title?: ReactNode;
  /** Controlled sort. */
  sort?: "newest" | "top";
  /** Uncontrolled sort. Default "newest". */
  defaultSort?: "newest" | "top";
  /** Gets the chosen sort. */
  onSort?: (sort: string) => void;
  /** Refresh click. */
  onRefresh?: MouseEventHandler<HTMLButtonElement>;
  /** Signed out shows "Sign in to comment". Default true. */
  signedIn?: boolean;
  /** Sign-in click. */
  onSignIn?: MouseEventHandler<HTMLButtonElement>;
  /** Composer slot. Default <Composer />. */
  composer?: ReactNode;
  /** Text with no comments. Default "Start the conversation. What do you think?". */
  empty?: ReactNode;
  /** Shows Load more. Default false. */
  hasMore?: boolean;
  /** Load more click. */
  onLoadMore?: MouseEventHandler<HTMLButtonElement>;
  /** The threads or comments of the list. A composer child takes the place of the default composer. */
  children?: ReactNode;
  /** Extra classes. Default "". */
  className?: string;
}
/** Discussion block: head with sort and refresh, composer, thread list. */
export function Discussion(props: DiscussionProps): JSX.Element;

export interface TopicChipProps {
  /** Icon before the text. */
  icon?: IconName;
  children?: ReactNode;
  /** Renders a link. */
  href?: string;
  /** Renders a toggle button with aria-pressed. */
  pressed?: boolean;
  /** Renders a toggle button. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Extra classes. Default "". */
  className?: string;
}
/** Linked topic of a stream: toggle button, link or plain chip. */
export function TopicChip(props: TopicChipProps): JSX.Element;

export interface TopicChipsProps {
  /** "fieldset" for a group of toggles. Default "div". */
  as?: "div" | "fieldset";
  /** Accessible name. Default "Linked topics". */
  label?: string;
  children?: ReactNode;
  /** Extra classes. Default "". */
  className?: string;
}
/** Row of topic chips. */
export function TopicChips(props: TopicChipsProps): JSX.Element;

/** (-1 | 0 | 1) of the viewer: 1 like, -1 dislike, 0 none. */

export interface TopicDetailProps {
  /** Stored category. Default "Tech & setups". */
  category?: string;
  /** Category icon. Default from category. */
  categoryIcon?: IconName;
  /** Topic title. */
  title: ReactNode;
  /** Author name. */
  author: ReactNode;
  /** Default 14. */
  authorPreset?: number | null;
  /** Author avatar URL. */
  authorUrl?: string | null;
  /** Topic text. */
  description?: ReactNode;
  /** Default 0. */
  likes?: number;
  /** Default 0. */
  dislikes?: number;
  /** Default 0. */
  reaction?: -1 | 0 | 1;
  /** Gets the next reaction. */
  onReact?: (reaction: -1 | 0 | 1) => void;
  /** Signed out disables voting and hides Report. Default true. */
  signedIn?: boolean;
  /** Topic link target. Default "?view=topics". */
  topicLink?: string;
  /** Default "All topics". */
  backLabel?: ReactNode;
  /** Back click. */
  onBack?: MouseEventHandler<HTMLButtonElement>;
  /** Open discussion click. */
  onDiscuss?: MouseEventHandler<HTMLButtonElement>;
  /** Shows Report. Default true. */
  report?: boolean;
  /** Shows the Reported chip. Default false. */
  reported?: boolean;
  /** Report click. */
  onReport?: MouseEventHandler<HTMLButtonElement>;
  /** A <Discussion> under the topic. */
  children?: ReactNode;
  /** Extra classes. Default "". */
  className?: string;
}
/** The selected topic panel with votes. */
export function TopicDetail(props: TopicDetailProps): JSX.Element;

export interface TopicRowProps {
  /** data-entry-id value. */
  id?: string;
  /** Topic title. */
  title: ReactNode;
  /** Icon. Default categoryIcon(category). */
  icon?: IconName;
  /** Stored category. */
  category?: string;
  /** Default 0. */
  likes?: number;
  /** Default 0. */
  dislikes?: number;
  /** Default 0. */
  comments?: number;
  /** Default false. */
  selected?: boolean;
  /** Row click. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Extra classes. Default "". */
  className?: string;
}
/** One row of the topic list. */
export function TopicRow(props: TopicRowProps): JSX.Element;

export interface VoteButtonsProps {
  /** Default 0. */
  reaction?: -1 | 0 | 1;
  /** Default 0. */
  likes?: number;
  /** Default 0. */
  dislikes?: number;
  /** Default false. */
  disabled?: boolean;
  /** Gets the next reaction; pressing the current one gives 0. */
  onReact?: (reaction: -1 | 0 | 1) => void;
  /** Default "Like". */
  likeLabel?: ReactNode;
  /** Default "Dislike". */
  dislikeLabel?: ReactNode;
  /** Extra classes. Default "". */
  className?: string;
}
/** Like and Dislike buttons of a topic. */
export function VoteButtons(props: VoteButtonsProps): JSX.Element;

// Polls

/** "closed": the time is up; "revealed": the host ended the poll. */
export type PollState = "live" | "closed" | "revealed";
/** "binary": yes/no poll with private results until the reveal. */
export type PollKind = "choice" | "binary";

export interface PollStatusProps {
  /** Default "live". */
  state?: PollState;
  /** Time left of a live poll; none means no time limit. */
  countdown?: ReactNode;
  /** Default "choice". */
  kind?: PollKind;
}
/** Gold top line of a poll. */
export function PollStatus(props: PollStatusProps): JSX.Element;

export interface PollResultsProps {
  /** Option texts. */
  options: readonly string[];
  /** Votes per option; shows the bars, votes and shares. */
  counts?: readonly number[];
  /** Index of the viewer vote. Default null. */
  myVote?: number | null;
  /** Makes the rows buttons; gets the option index. */
  onVote?: (index: number) => void;
  /** Default false. */
  disabled?: boolean;
  /** Default "choice". */
  kind?: PollKind;
}
/** Option rows of a poll. */
export function PollResults(props: PollResultsProps): JSX.Element;

export interface PollCardProps {
  /** data-entry-id value. */
  id?: string;
  /** Poll question. */
  title: string;
  /** Author name. */
  author: ReactNode;
  /** Default 14. */
  authorPreset?: number | null;
  /** Author avatar URL. */
  authorUrl?: string | null;
  /** Option texts. */
  options: readonly string[];
  /** Votes per option. */
  counts?: readonly number[];
  /** Index of the viewer vote. Default null. */
  myVote?: number | null;
  /** Gets the option index. */
  onVote?: (index: number) => void;
  /** Default "live". */
  state?: PollState;
  /** Time left of a live poll. */
  countdown?: ReactNode;
  /** Default "choice". */
  kind?: PollKind;
  /** Signed out disables voting. Default true. */
  signedIn?: boolean;
  /** Shows the owner menu and End & reveal. Default false. */
  owner?: boolean;
  /** Reveal or end click. */
  onReveal?: MouseEventHandler<HTMLButtonElement>;
  /** Delete click. */
  onDelete?: MouseEventHandler<HTMLButtonElement>;
  /** Comment count. Default 0. */
  comments?: number;
  /** Discuss click. */
  onDiscuss?: MouseEventHandler<HTMLButtonElement>;
  /** Poll link target. Default "?view=polls". */
  href?: string;
  /** Extra classes. Default "". */
  className?: string;
}
/** A poll card with status, options, footer and links. */
export function PollCard(props: PollCardProps): JSX.Element;

export interface PollDiscussionProps {
  /** Poll question, for the hidden heading. */
  title: ReactNode;
  /** Shows Report. Default true. */
  report?: boolean;
  /** Shows the Reported chip. Default false. */
  reported?: boolean;
  /** Report click. */
  onReport?: MouseEventHandler<HTMLButtonElement>;
  /** Open discussion click. */
  onDiscuss?: MouseEventHandler<HTMLButtonElement>;
  /** A <Discussion>. */
  children?: ReactNode;
}
/** Box under an open poll: Report, Open discussion and the discussion. */
export function PollDiscussion(props: PollDiscussionProps): JSX.Element;

// Shell

export interface NotificationLinkProps {
  /** Unread count; shows the badge. Default 0. */
  unread?: number;
  /** Load error; shows the warning icon. Default "". */
  error?: string;
  /** Name with no unread. Default "Notifications". */
  label?: string;
  /** Opens the notifications dialog. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}
/** Inbox button left of the avatar. */
export function NotificationLink(props: NotificationLinkProps): JSX.Element;

export interface SignInButtonProps {
  /** Default "Sign in / Sign up". */
  label?: string;
  /** Phone text. Default "Sign in". */
  shortLabel?: ReactNode;
  /** Default "header-signin". */
  className?: string;
  /** Sign-in click. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}
/** Header control for signed-out readers. */
export function SignInButton(props: SignInButtonProps): JSX.Element;

export interface AccountMenuLink {
  /** Row id, passed to onSelect. */
  id: string;
  /** Row text. */
  label: ReactNode;
  /** Row icon. */
  icon: IconName;
  /** Row link. */
  href: string;
  /** Opens a dialog (aria-haspopup). */
  dialog?: boolean;
  /** Marks the current page. */
  current?: boolean;
}
/** A menu row, or "divider" between groups. */
export type AccountMenuItem = AccountMenuLink | "divider";
export interface AccountMenuItemsOptions {
  /** Own page handle; adds the own-page tools. */
  handle?: string;
  /** Adds Admin. Default false. */
  admin?: boolean;
  /** Adds Streamers. Default false. */
  streamerHeader?: boolean;
  /** Id of the current row. */
  current?: string;
}
/** Rows of the account menu, in the app order. */
export function accountMenuItems(options?: AccountMenuItemsOptions): AccountMenuItem[];

export interface AccountMenuProps {
  /** Default "Sunny". */
  name?: string;
  /** Own page handle. */
  handle?: string;
  /** Default false. */
  admin?: boolean;
  /** Role line. Default from handle and admin. */
  subtitle?: ReactNode;
  /** Default 14. */
  preset?: number | null;
  /** Avatar URL. */
  avatar?: string | null;
  /** Rows. Default accountMenuItems(). */
  items?: readonly AccountMenuItem[];
  /** Id of the current row. */
  current?: string;
  /** Default false. */
  streamerHeader?: boolean;
  /** Page status; frozen or suspended adds the notice and dot. */
  notice?: "active" | "frozen" | "suspended";
  /** Notice text. */
  noticeText?: ReactNode;
  /** Default 0. */
  unread?: number;
  /** Shows the notifications button. Default true. */
  notifications?: boolean;
  /** Notifications click. */
  onNotifications?: MouseEventHandler<HTMLButtonElement>;
  /** Controlled open state. */
  open?: boolean;
  /** Default false. */
  defaultOpen?: boolean;
  /** Gets the next open state. */
  onOpenChange?: (open: boolean) => void;
  /** Gets the row id, or "sign-out". */
  onSelect?: (id: string) => void;
  /** Disables Sign out. Default false. */
  signingOut?: boolean;
}
/** Notifications button, avatar button and account menu panel. */
export function AccountMenu(props: AccountMenuProps): JSX.Element;

export interface BackLinkProps {
  /** Default "Streamers". */
  name?: string;
  /** Default "/streamers". */
  href?: string;
  /** Link text. Default "Back to <name>". */
  children?: ReactNode;
}
/** "Back to …" link. */
export function BackLink(props: BackLinkProps): JSX.Element;

/** Footer link ids. */
export type FooterPath = "streamers" | "privacy" | "terms" | "reporting" | "a11y" | "ideas" | "ai" | "language";
export interface SiteFooterProps {
  /** Id of the current page. */
  current?: FooterPath;
  /** Link overrides. Default {}. */
  paths?: Partial<Record<FooterPath, string>>;
  /** Language tag of the language name. Default "en". */
  locale?: string;
  /** Default "English". */
  language?: string;
  /** Contact click. */
  onContact?: () => void;
  /** Extra classes. Default "". */
  className?: string;
}
/** Site footer: full row on wide screens, icon links and a More sheet on phones. */
export function SiteFooter(props: SiteFooterProps): JSX.Element;

export interface SiteLogoProps {
  /** Default "/". */
  href?: string;
  /** Default "StreamBullets home". */
  label?: string;
}
/** Home link of the site header. */
export function SiteLogo(props: SiteLogoProps): JSX.Element;

export interface HeaderLanguageProps {
  /** Shows the language code. Default "en". */
  locale?: string;
  /** Full language name. Default "English". */
  name?: string;
  /** Opens the language dialog. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}
/** Globe button with the language code. */
export function HeaderLanguage(props: HeaderLanguageProps): JSX.Element;

export interface HeaderAccountProps {
  /** Shows the account menu, else Sign in. */
  signedIn?: boolean;
  /** AccountMenu props. */
  account?: Partial<AccountMenuProps>;
  /** Account avatar preset. */
  avatarPreset?: number | null;
  /** Gets the menu open state. */
  onAccount?: (open: boolean) => void;
  /** Sign-in click. */
  onSignIn?: MouseEventHandler<HTMLButtonElement>;
  /** Language tag. */
  locale?: string;
  /** Language name. */
  languageName?: string;
  /** Language click. */
  onLanguage?: MouseEventHandler<HTMLButtonElement>;
  /** Adds Streamers to the menu. */
  streamerHeader?: boolean;
}
/** Header end: language, then notifications and the avatar menu, or Sign in. */
export function HeaderAccount(props: HeaderAccountProps): JSX.Element;

export interface SiteHeaderLink {
  /** Link id; compared with current. */
  id: string;
  /** Link text. */
  label: ReactNode;
  /** Link target. */
  href: string;
  /** Icon before the text. */
  icon?: IconName;
  /** Hidden on phones. */
  optional?: boolean;
}
export interface SiteHeaderProps {
  /** Id of the current link. Default "streamers". */
  current?: string;
  /** Navigation links. Default the Streamers link. */
  links?: readonly SiteHeaderLink[];
  /** Default "/". */
  homeHref?: string;
  /** Default true. */
  signedIn?: boolean;
  /** Default 14. */
  avatarPreset?: number | null;
  /** AccountMenu props. */
  account?: Partial<AccountMenuProps>;
  /** Sign-in click. */
  onSignIn?: MouseEventHandler<HTMLButtonElement>;
  /** Gets the menu open state. */
  onAccount?: (open: boolean) => void;
  /** Default "en". */
  locale?: string;
  /** Default "English". */
  languageName?: string;
  /** Language click. */
  onLanguage?: MouseEventHandler<HTMLButtonElement>;
  /** Extra classes. Default "". */
  className?: string;
}
/** Header of directory, legal, account and error pages. */
export function SiteHeader(props: SiteHeaderProps): JSX.Element;

/** Tabs of a streamer page. */
/** Path builder for a handle: "home", "streamers", "tools", "page" or a view id -> URL. */
export function streamerHref(handle: string): (id: string) => string;

export interface HeaderSuggestButtonProps {
  /** Default "Suggest an improvement". */
  label?: string;
  /** Default false. */
  disabled?: boolean;
  /** Button click. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}
/** Gold header action of the official StreamBullets page. */
export function HeaderSuggestButton(props: HeaderSuggestButtonProps): JSX.Element;

export interface StreamerHeaderProps {
  /** Default "Sunny". */
  name?: string;
  /** Default "sunny". */
  handle?: string;
  /** Owner preset. Default 14. */
  preset?: number | null;
  /** Owner avatar URL. */
  avatar?: string | null;
  /** Page logo URL. */
  logo?: string | null;
  /** Current tab, or "tools". Default "topics". */
  current?: ("topics" | "polls" | "schedule" | "about" | "community") | "tools";
  /** Tabs. Default all five views. */
  views?: readonly ("topics" | "polls" | "schedule" | "about" | "community")[];
  /** Tab label overrides. Default {}. */
  labels?: Partial<Record<"topics" | "polls" | "schedule" | "about" | "community", string>>;
  /** Tab icon overrides. Default {}. */
  icons?: Partial<Record<"topics" | "polls" | "schedule" | "about" | "community", IconName>>;
  /** Gives the address of a view. The default uses the handle. */
  hrefFor?: (id: string) => string;
  /** Shows in place of the streamer picture and name. */
  brand?: ReactNode;
  /** Shows the live pill. Default false. */
  live?: boolean;
  /** The title of the running event, for the live pill. */
  liveTitle?: ReactNode;
  /** Shows in place of the live pill. */
  badge?: ReactNode;
  /** The on-air strip below the header. Text gets the default strip. */
  ticker?: ReactNode;
  /** Own page: adds the Tools tab and own account. Default false. */
  own?: boolean;
  /** Header action, e.g. HeaderSuggestButton. Default null. */
  action?: ReactNode;
  /** Default true. */
  signedIn?: boolean;
  /** Viewer preset when not own. Default 14. */
  avatarPreset?: number | null;
  /** AccountMenu props. */
  account?: Partial<AccountMenuProps>;
  /** Gets the menu open state. */
  onAccount?: (open: boolean) => void;
  /** Sign-in click. */
  onSignIn?: MouseEventHandler<HTMLButtonElement>;
  /** Default "en". */
  locale?: string;
  /** Default "English". */
  languageName?: string;
  /** Language click. */
  onLanguage?: MouseEventHandler<HTMLButtonElement>;
  /** Extra classes. Default "". */
  className?: string;
}
/** Header of a streamer page. */
export function StreamerHeader(props: StreamerHeaderProps): JSX.Element;

// Overlay

/** Chat platforms. */
export type ChatPlatform = "twitch" | "youtube" | "kick";
/** A text run or an emote of a chat message. */
export type ChatFragment = { type: "text"; text: string } | { type: "emote"; name: string; url?: string; id?: string };
export interface ChatRow {
  /** Row id. Default the index. */
  id?: string;
  /** Source platform. */
  platform: ChatPlatform;
  /** User name; cut to 20 characters. */
  name: string;
  /** Badge texts; at most two show. */
  badges?: readonly string[];
  /** Message parts. Default one text fragment from text. */
  fragments?: readonly ChatFragment[];
  /** Plain message when fragments is absent. */
  text?: string;
  /** Adds an ellipsis. */
  truncated?: boolean;
  /** Shows the removed text. */
  removed?: boolean;
  /** Leaving phase. */
  leaving?: boolean;
  /** Entering phase (slide in). */
  enter?: boolean;
  /** Fading out. */
  gone?: boolean;
}
/** Cuts a name to max user-perceived characters (default 20), ending in an ellipsis. */
export function shortName(name: string, max?: number): string;

export interface ChatLayerProps {
  /** Messages, oldest first. */
  rows: readonly ChatRow[];
  /** Card background opacity, 0..100; below 50 the text gets an outline. Default 100. */
  backgroundOpacity?: number;
  /** Shows the TEST tag. Default false. */
  test?: boolean;
  /** List name. Default "Chat". */
  label?: string;
  /** Default "message removed by a moderator". */
  removedText?: ReactNode;
  /** Default "TEST". */
  testLabel?: ReactNode;
  /** Extra classes. */
  className?: string;
  /** Style overrides after the theme variables. */
  style?: CSSProperties;
}
/** Merged chat in the wasteland theme; fills its positioned parent. */
export function ChatLayer(props: ChatLayerProps): JSX.Element;

/** Layers of the overlay grid. */
export type OverlayGridLayer =
  | "chat"
  | "characters"
  | "poll"
  | "topic"
  | "next"
  | "message"
  | "card"
  | "support"
  | "camera";
/** Content source types of a stage. */
export type OverlaySourceType = "auto" | "poll" | "topic" | "next" | "message" | "card" | "support";
/** A rectangle in design pixels. */
export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayCompositionProps {
  /** The single layer group shown; none means the whole composition. */
  only?: "content" | "chat" | "characters" | null;
  children?: ReactNode;
}
/** The layers of the overlay, at the size of the positioned parent. */
export function OverlayComposition(props: OverlayCompositionProps): JSX.Element;

export interface OverlayStageProps {
  /** data-overlay-type value. Default "poll". */
  type?: OverlaySourceType;
  children?: ReactNode;
}
/** Content of one layer in its cell, centred at the full width. */
export function OverlayStage(props: OverlayStageProps): JSX.Element;

export interface OverlayLayerProps {
  /** Default "poll". */
  layer?: OverlayGridLayer;
  /** Stage type of a content layer. Default layer. */
  type?: OverlaySourceType;
  /** Cell in design pixels. */
  rect: OverlayRect;
  /** Design size of the composition. Default { w: 1920, h: 1080 }. */
  frame?: { w: number; h: number };
  /** Fills the parent, as a per-layer OBS source. Default false. */
  alone?: boolean;
  /** Background opacity 0..100. Default 100 for content layers. */
  backgroundOpacity?: number;
  children?: ReactNode;
}
/** A layer box at its cell; content layers get the fit box and stage. */
export function OverlayLayer(props: OverlayLayerProps): JSX.Element;

export interface OverlayCameraProps {
  /** Text in the window, for the editor preview. The overlay page has none. */
  hint?: string;
}
/** The camera frame: a frame with a clear window. Put it in an OverlayLayer with layer "camera". */
export function OverlayCamera(props: OverlayCameraProps): JSX.Element;

export interface OverlayQrProps {
  /** Encoded link. */
  url: string;
  /** Image alt text. Default "QR code: open on your phone". */
  label?: string;
}
/** QR code of a card, sized from its card (memoized). */
export declare const OverlayQr: NamedExoticComponent<OverlayQrProps>;

export interface OverlayCardProps {
  /** Default "topic". */
  kind?: "topic" | "next" | "message" | "card" | "support";
  /** Top line. Default by kind. */
  eyebrow?: ReactNode;
  /** Heading; message and support have a default. */
  title?: ReactNode;
  /** Topic author. */
  author?: ReactNode;
  /** Default 14. */
  authorPreset?: number | null;
  /** Topic author avatar URL. */
  authorSrc?: string | null;
  /** Topic likes. Default 0. */
  likes?: number;
  /** Next stream time text. */
  when?: ReactNode;
  /** Next stream pill. */
  startsIn?: ReactNode;
  /** Community card eyebrow name. Default "Sunny". */
  streamer?: string;
  /** Community card text. */
  body?: ReactNode;
  /** Community card call to action. */
  cta?: ReactNode;
  /** Community card link, shown without https://. */
  ctaTarget?: string;
  /** Support link, shown without https://. */
  link?: string;
  /** Message banner style. Default "info". */
  messageStyle?: "info" | "hype";
  /** QR code link; null for none. Default null. */
  qr?: string | null;
}
/** On-air cards: topic spotlight, up next, message, community card and support. */
export function OverlayCard(props: OverlayCardProps): JSX.Element;

export interface OverlayPollProps {
  /** data-overlay-poll value. Default "poll". */
  id?: string;
  /** Question; fitted to its box. */
  title: string;
  /** Option texts. */
  options: readonly string[];
  /** Votes per option; undefined hides the bars. */
  counts?: readonly number[];
  /** Vote total. Default the sum of counts. */
  total?: number;
  /** Default "choice". */
  kind?: PollKind;
  /** Default false. */
  revealed?: boolean;
  /** Seconds left; null means no time limit. Default null. */
  secondsLeft?: number | null;
  /** Default true. */
  showResults?: boolean;
  /** QR code link. Default null. */
  qr?: string | null;
}
/** A poll on stream; fills its cell. */
export function OverlayPoll(props: OverlayPollProps): JSX.Element;

export interface OverlayMashProps {
  /** Default "Sunny". */
  streamer?: string;
  /** Battle title. */
  title: ReactNode;
  /** Side names. */
  sides: readonly string[];
  /** Taps per side. */
  totals: readonly number[];
  /** Default "live". */
  phase?: "setup" | "countdown" | "live" | "finished";
  /** Seconds left while live. Default duration. */
  left?: number;
  /** Battle length in seconds. Default 30. */
  duration?: number;
  /** Winner index, -1 for a draw. Default from totals. */
  winner?: number;
  /** Default true. */
  showResults?: boolean;
  /** Default "streambullets.com". */
  host?: string;
  /** Default "sunny". */
  handle?: string;
  /** QR code link. Default null. */
  qr?: string | null;
}
/** A Mash Battle on stream: ring or winner, tug-of-war bar, totals and "Tap at" link. */
export function OverlayMash(props: OverlayMashProps): JSX.Element;

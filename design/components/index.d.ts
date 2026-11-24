// Types of the parts in src/index.js, for documentation.
import type {
  ButtonHTMLAttributes,
  ChangeEventHandler,
  InputHTMLAttributes,
  MouseEventHandler,
  ReactNode,
} from "react";

// Avatar.d.ts
export interface AvatarProps {
  /** Uploaded photo URL. When absent a preset portrait renders. */
  src?: string | null;
  /** 0–15 sprite portraits, 16 Jack Russell, 17 alien. Default 14 (Space explorer). Never initials. */
  preset?: number;
  /** 20 · 32 · 40 · 42 (default) · 44 · 48 · 60 · 76 */
  size?: number;
  /** gold 1px (default) or cream 3px (streamer brand avatar). */
  ring?: "gold" | "cream";
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}
export function Avatar(props: AvatarProps): JSX.Element;

// Button.d.ts
/**
 * Native button with StreamBullets chrome: 1px #849291 border, 3px radius, teal gradient, 44px min height.
 * @startingPoint section="Core" subtitle="Default, gold, danger, ghost, link buttons" viewport="700x360"
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** gold = primary action (one per view). danger = destructive. ghost = header tab-like. link = inline gold text. */
  variant?: "default" | "gold" | "danger" | "ghost" | "link";
  /** sm 32px (inline reactions), md 44px, lg 48px (header CTA). */
  size?: "sm" | "md" | "lg";
  /** display = Oswald uppercase (CTAs, headers). body = Figtree 600 (secondary actions). */
  font?: "body" | "display";
  icon?: IconName;
  iconEnd?: IconName;
  /** Landing-page chunky button with offset shadow. */
  landing?: boolean;
  /** Toggle state; pressed renders gold. */
  pressed?: boolean;
  children?: ReactNode;
}
export function Button(props: ButtonProps): JSX.Element;

// Icon.d.ts
/** Local glyphs (icon-paths.tsx) + Lucide names mapped in icon.tsx. */
export type IconName =
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
  | "down"
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
  | "copy"
  | "external"
  | "image"
  | "crop"
  | "reset"
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
  | "zap";
/** 16 metadata/footer · 18 buttons/menus · 20 navigation/close · 24 categories/votes · 40 empty states. */
export type IconSize = 14 | 16 | 18 | 20 | 24 | 32 | 40;
export interface IconProps {
  name: IconName;
  size?: IconSize;
  className?: string;
  style?: React.CSSProperties;
  /** Only when the icon stands alone and carries meaning; otherwise decorative (aria-hidden). */
  label?: string;
}
export function Icon(props: IconProps): JSX.Element;

// IconButton.d.ts
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name and tooltip. Required. */
  label: string;
  icon: IconName;
  iconSize?: IconSize;
  /** bare = transparent, muted (dialog close). */
  variant?: "default" | "bare";
}
export function IconButton(props: IconButtonProps): JSX.Element;

// Logo.d.ts
export interface LogoProps {
  /** full = wordmark (305×84), icon = mark only (128×136, phones / streamer header). */
  kind?: "full" | "icon";
  /** px height; width follows aspect ratio. Defaults 56 (full) / 44 (icon). */
  height?: number;
  label?: string;
  className?: string;
}
export function Logo(props: LogoProps): JSX.Element;

// Choice.d.ts
export interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  type?: "radio" | "checkbox";
  label: ReactNode;
  help?: string;
}
export function Choice(props: ChoiceProps): JSX.Element;

// Req.d.ts
/** Visible gold required marker; hidden from assistive tech (native required carries semantics). */
export interface ReqProps {}
export function Req(props: ReqProps): JSX.Element;
export interface RequiredNoteProps {
  children?: React.ReactNode;
}
export function RequiredNote(props: RequiredNoteProps): JSX.Element;

// SearchField.d.ts
export interface SearchFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visually hidden label. */
  label?: string;
  placeholder?: string;
}
export function SearchField(props: SearchFieldProps): JSX.Element;

// Select.d.ts
export interface SelectOption {
  value: string;
  label: string;
  icon?: IconName;
}
export interface SelectProps {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** Accessible name when no visible label is linked. */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}
export function Select(props: SelectProps): JSX.Element;

// Tabs.d.ts
export interface TabsItem {
  value: string;
  label: string;
}
export interface TabsProps {
  items: readonly TabsItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Group label, e.g. "Topic sorting". */
  label?: string;
  className?: string;
}
export function Tabs(props: TabsProps): JSX.Element;

// TextField.d.ts
/**
 * Labelled input or textarea as used in dialogs and settings.
 */
export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  help?: string;
  /** Error text; also sets aria-invalid and the #ffbeaa border. */
  error?: string;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
}
export function TextField(props: TextFieldProps): JSX.Element;

// Banner.d.ts
export interface BannerProps {
  /** frozen = ice-blue bar (page read-only); suspended = error bar. */
  tone?: "frozen" | "suspended";
  children: ReactNode;
  className?: string;
}
export function Banner(props: BannerProps): JSX.Element;

// Dialog.d.ts
export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Gold Oswald uppercase title. */
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Primary actions; placed after Cancel (Cancel first, primary last). */
  actions?: ReactNode;
  cancel?: boolean;
  cancelLabel?: string;
  /** Render in flow without backdrop (cards, docs). */
  inline?: boolean;
  className?: string;
}
export function Dialog(props: DialogProps): JSX.Element | null;

// EmptyState.d.ts
export interface EmptyStateProps {
  title: string;
  icon?: IconName;
  children?: ReactNode;
  /** Optional CTA below the text. */
  action?: ReactNode;
  className?: string;
}
export function EmptyState(props: EmptyStateProps): JSX.Element;

// LivePill.d.ts
export interface LivePillProps {
  label?: string;
  pulse?: boolean;
  className?: string;
}
export function LivePill(props: LivePillProps): JSX.Element;

// Sheet.d.ts
export interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  /** Shows a gold "‹ Back" step button in the header. */
  onBack?: () => void;
  backLabel?: string;
  children?: ReactNode;
  /** Docked footer buttons. */
  actions?: ReactNode;
  inline?: boolean;
  className?: string;
}
export function Sheet(props: SheetProps): JSX.Element | null;

// Toast.d.ts
export interface ToastProps {
  message: string;
  /** error = dark red, announced assertively. */
  tone?: "status" | "error";
  /** e.g. Undo. Toasts with actions stay ≥10s. */
  action?: { label: string; onClick: () => void };
  /** Fixed bottom-center (64px above bottom). */
  floating?: boolean;
  className?: string;
}
export function Toast(props: ToastProps): JSX.Element;

// Category.d.ts
export interface CategoryProps {
  /** cat-tech · cat-gaming · cat-creative · cat-chatting or any icon. */
  icon?: IconName;
  children: ReactNode;
  className?: string;
}
export function Category(props: CategoryProps): JSX.Element;

// Discussion.d.ts
export interface DiscussionProps {
  title?: string;
  count?: number;
  /** Show the Top / Newest sort select. */
  sort?: boolean;
  children?: ReactNode;
  className?: string;
}
export function Discussion(props: DiscussionProps): JSX.Element;
export interface CommentProps {
  name: string;
  /** e.g. "Community member", "Streamer" */
  subtitle?: string;
  preset?: number;
  time?: string;
  children: ReactNode;
  likes?: number;
  liked?: boolean;
  /** Indent as a reply. */
  reply?: boolean;
  onLike?: () => void;
  onReply?: () => void;
}
export function Comment(props: CommentProps): JSX.Element;
export interface ComposerProps {
  placeholder?: string;
  postLabel?: string;
  value?: string;
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
  onPost?: () => void;
  replyingTo?: string;
}
export function Composer(props: ComposerProps): JSX.Element;

// TopicChip.d.ts
export interface TopicChipProps {
  icon?: IconName;
  children: ReactNode;
  /** Toggle filter; pressed = gold. */
  pressed?: boolean;
  onClick?: () => void;
  className?: string;
}
export function TopicChip(props: TopicChipProps): JSX.Element;

// TopicDetail.d.ts
/**
 * Right-hand topic detail panel: category, title, author, body, votes; discussion goes in children.
 * @startingPoint section="Board" subtitle="Topic detail with votes and discussion" viewport="760x640"
 */
export interface TopicDetailProps {
  category?: string;
  categoryIcon?: IconName;
  /** e.g. "Topic 001" */
  number?: string;
  title: string;
  author?: string;
  authorPreset?: number;
  description?: string;
  likes?: number;
  dislikes?: number;
  reaction?: -1 | 0 | 1;
  onReact?: (v: -1 | 0 | 1) => void;
  /** Usually a <Discussion>. */
  children?: ReactNode;
  className?: string;
}
export function TopicDetail(props: TopicDetailProps): JSX.Element;

// TopicRow.d.ts
/**
 * One row of the topic board list. Selected row fills gold.
 * @startingPoint section="Board" subtitle="Topic list rows with counts" viewport="700x420"
 */
export interface TopicRowProps {
  title: string;
  icon?: IconName;
  likes?: number;
  dislikes?: number;
  comments?: number;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}
export function TopicRow(props: TopicRowProps): JSX.Element;

// VoteButtons.d.ts
export interface VoteButtonsProps {
  /** 1 liked, -1 disliked, 0 none. */
  reaction?: -1 | 0 | 1;
  likes?: number;
  dislikes?: number;
  disabled?: boolean;
  /** lg = topic detail (201×55, Oswald). sm = poll react row (icon + count). */
  size?: "lg" | "sm";
  onReact?: (value: -1 | 0 | 1) => void;
  likeLabel?: string;
  dislikeLabel?: string;
  className?: string;
}
export function VoteButtons(props: VoteButtonsProps): JSX.Element;

// PollCard.d.ts
/**
 * Audience poll card: status line, title, author, options with result fills, footer, reactions.
 * @startingPoint section="Polls" subtitle="Live poll with results and reactions" viewport="760x620"
 */
export interface PollCardProps {
  title: string;
  author?: string;
  authorPreset?: number;
  options: readonly string[];
  /** Per-option vote counts; omit to hide results. Shares use largest-remainder rounding (sum to 100). */
  counts?: readonly number[];
  myVote?: number | null;
  onVote?: (index: number) => void;
  state?: "live" | "closed" | "revealed";
  /** e.g. "2 min left" */
  countdown?: string;
  /** binary = two side-by-side options (Yes / No). */
  kind?: "choice" | "binary";
  /** Owner sees End & reveal. */
  owner?: boolean;
  onReveal?: () => void;
  likes?: number;
  dislikes?: number;
  reaction?: -1 | 0 | 1;
  onReact?: (v: -1 | 0 | 1) => void;
  comments?: number;
  onDiscuss?: () => void;
  className?: string;
}
export function PollCard(props: PollCardProps): JSX.Element;
export interface PollStatusProps {
  state?: "live" | "closed" | "revealed";
  countdown?: string;
}
export function PollStatus(props: PollStatusProps): JSX.Element;
export interface PollResultsProps {
  options: readonly string[];
  counts?: readonly number[];
  myVote?: number | null;
  onVote?: (i: number) => void;
  disabled?: boolean;
  kind?: "choice" | "binary";
}
export function PollResults(props: PollResultsProps): JSX.Element;

// AccountMenu.d.ts
export type AccountMenuItem = { id: string; label: string; icon: IconName } | "divider";
export interface AccountMenuProps {
  name: string;
  /** "Viewer", "Streamer · @handle", "Administrator" */
  subtitle?: string;
  preset?: number;
  items?: readonly AccountMenuItem[];
  current?: string;
  onSelect?: (id: string) => void;
  className?: string;
}
export function AccountMenu(props: AccountMenuProps): JSX.Element;

// BackLink.d.ts
export interface BackLinkProps {
  children?: ReactNode;
  href?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}
export function BackLink(props: BackLinkProps): JSX.Element;

// SiteFooter.d.ts
export interface SiteFooterProps {
  /** Default: Privacy, Terms, Report content and AI agents, with the paths of app/lib/shell.ts. */
  links?: readonly { label: string; href: string }[];
  /** Current language name in its own script, e.g. "Deutsch". */
  language?: string;
  onLanguage?: () => void;
  className?: string;
}
export function SiteFooter(props: SiteFooterProps): JSX.Element;

// SiteHeader.d.ts
/**
 * Generic site header (directory, legal, settings): wordmark, Figtree nav links, account avatar or Sign in.
 * @startingPoint section="Shell" subtitle="Site header with wordmark and account" viewport="1200x120"
 */
export interface SiteHeaderProps {
  current?: string;
  /** A link without href goes to #id. */
  links?: readonly { id: string; label: string; icon?: IconName; href?: string }[];
  /** Default "/". */
  homeHref?: string;
  signedIn?: boolean;
  avatarPreset?: number;
  onSignIn?: () => void;
  onAccount?: () => void;
  className?: string;
}
export function SiteHeader(props: SiteHeaderProps): JSX.Element;

// StreamerHeader.d.ts
/**
 * Streamer page header: SB mark | divider | streamer avatar + name, Oswald uppercase view tabs, Streamers link, gold CTA, account.
 * @startingPoint section="Shell" subtitle="Streamer page header with view tabs" viewport="1360x140"
 */
export interface StreamerHeaderProps {
  name: string;
  preset?: number;
  current?: "topics" | "polls" | "schedule" | "about" | "community" | "overlay" | null;
  /** The href of each link: a view id, "home" or "streamers". Default `#${id}`. */
  hrefFor?: (id: string) => string;
  /** Show the red LIVE pill. */
  live?: boolean;
  /** On-air ticker strip text under the header while live. */
  ticker?: ReactNode;
  /** Page owner: adds the Overlay tab. */
  own?: boolean;
  /** The action at the end of the header. The default is the gold Suggest a topic button. Null shows no action. */
  action?: ReactNode;
  signedIn?: boolean;
  avatarPreset?: number;
  onAccount?: () => void;
  /** Phone/narrow: icon-only tabs on a second row. */
  compact?: boolean;
  className?: string;
}
export function StreamerHeader(props: StreamerHeaderProps): JSX.Element;

// ChatLayer.d.ts
/**
 * Merged Twitch / YouTube / Kick chat for OBS: compact "wasteland" cards, newest at bottom, top 18% faded.
 * @startingPoint section="Overlay" subtitle="Merged chat layer for OBS" viewport="600x840"
 */
export interface ChatRow {
  id?: string;
  platform: "twitch" | "youtube" | "kick";
  name: string;
  text?: string;
  /** Up to 2 small grey labels before the name, e.g. "MOD", "SUB". */
  badges?: readonly string[];
  /** Shows "message removed by a moderator" in grey italic. */
  removed?: boolean;
  /** Play the 520ms rise-in. */
  enter?: boolean;
}
export interface ChatLayerProps {
  rows: readonly ChatRow[];
  /** 0–100 card background. Below 50 the text gets a dark outline. */
  backgroundOpacity?: number;
  /** Shows the TEST tag (chat test). */
  test?: boolean;
  /** true (default) fills its positioned parent; false flows statically. */
  absolute?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
export function ChatLayer(props: ChatLayerProps): JSX.Element;

// OverlayCard.d.ts
/**
 * On-air content cards for the 1920×1080 OBS browser source (design pixels). Gold 6px left rule.
 * @startingPoint section="Overlay" subtitle="OBS on-air cards: topic, up next, message, poll" viewport="1280x720"
 */
export interface OverlayCardProps {
  kind?: "topic" | "next" | "message" | "card" | "support";
  /** Overrides the default eyebrow ("Topic spotlight", "Up next", community name). */
  eyebrow?: string;
  title: string;
  author?: string;
  authorPreset?: number;
  likes?: number;
  /** kind=next: formatted local start, e.g. "Fri 8:00 PM" */
  when?: string;
  /** kind=next: gold pill, e.g. "in 45 min" */
  startsIn?: string;
  body?: string;
  cta?: string;
  messageStyle?: "info" | "hype";
  className?: string;
  style?: React.CSSProperties;
}
export function OverlayCard(props: OverlayCardProps): JSX.Element;
export interface OverlayPollProps {
  streamer: string;
  title: string;
  options: readonly string[];
  counts: readonly number[];
  countdown?: string;
  showResults?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
export function OverlayPoll(props: OverlayPollProps): JSX.Element;

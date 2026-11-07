import type { ReactNode } from "react";
import {
  ArrowRight,
  AtSign,
  Cast,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  Clock,
  Compass,
  Copy,
  Crop,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Hourglass,
  House,
  Image,
  Inbox,
  KeyRound,
  Lightbulb,
  Link,
  ListChecks,
  Lock,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  Mic,
  Minus,
  Pencil,
  Plus,
  Radio,
  RadioTower,
  RotateCcw,
  Save,
  Send,
  Shield,
  ShieldCheck,
  Timer,
  ToggleRight,
  TrendingUp,
  TriangleAlert,
  Tv,
  UserCheck,
  UserRound,
  UserX,
  Wifi,
  WifiOff,
  X,
  Zap,
  Heart,
  Megaphone,
  type LucideIcon,
} from "lucide-react";
import { localIcons, type LocalIconName } from "./icon-paths";

/** Icons drawn by Lucide (stroke 1.8). Names follow the approved set in scratchpad/icons/mapping.md. */
const lucideIcons = {
  streamers: Tv,
  "your-page": RadioTower,
  admin: Shield,
  home: House,
  user: UserRound,
  pencil: Pencil,
  mic: Mic,
  data: Database,
  "sign-in": LogIn,
  "sign-out": LogOut,
  "at-sign": AtSign,
  plus: Plus,
  minus: Minus,
  close: X,
  send: Send,
  save: Save,
  link: Link,
  copy: Copy,
  external: ExternalLink,
  image: Image,
  crop: Crop,
  reset: RotateCcw,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "arrow-right": ArrowRight,
  "sort-top": TrendingUp,
  "sort-new": Clock,
  "poll-choice": ListChecks,
  "poll-binary": ToggleRight,
  timer: Timer,
  live: Radio,
  eye: Eye,
  "eye-off": EyeOff,
  stop: CircleStop,
  lock: Lock,
  overlay: Cast,
  wifi: Wifi,
  "wifi-off": WifiOff,
  requests: Inbox,
  key: KeyRound,
  approve: UserCheck,
  reject: UserX,
  mail: Mail,
  globe: Globe,
  "shield-check": ShieldCheck,
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  pending: Hourglass,
  rejected: CircleX,
  idea: Lightbulb,
  compass: Compass,
  privacy: LockKeyhole,
  terms: FileText,
  zap: Zap,
  heart: Heart,
  megaphone: Megaphone,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof lucideIcons | LocalIconName;
export type IconSize = 14 | 16 | 18 | 20 | 24 | 40;

/**
 * One decorative icon: `aria-hidden`, colour from `currentColor`. Put the accessible name on the control
 * (visible text, or `aria-label` on an icon-only button). Sizes follow mapping.md: 16 meta and footer,
 * 18 buttons and menus, 20 header nav and dialog close, 24 category chips and votes, 40 empty states.
 */
export function Icon({
  name,
  size = 18,
  className = "",
}: Readonly<{ name: IconName; size?: IconSize; className?: string }>): ReactNode {
  const classes: string = `icon icon-${size} icon-${name} ${className}`.trim();
  if (name in localIcons)
    return (
      <svg
        className={classes}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {localIcons[name as LocalIconName]}
      </svg>
    );
  const Lucide: LucideIcon = lucideIcons[name as keyof typeof lucideIcons];
  return <Lucide className={classes} size={size} strokeWidth={1.8} aria-hidden="true" focusable="false" />;
}

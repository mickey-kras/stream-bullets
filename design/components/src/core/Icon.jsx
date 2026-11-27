import {
  ArrowRight,
  AtSign,
  Bold,
  Cast,
  ChartLine,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  Clock,
  Code,
  Compass,
  Copy,
  Crop,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Heart,
  Hourglass,
  House,
  Image,
  Inbox,
  Italic,
  KeyRound,
  Languages,
  Layers,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Lock,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  Megaphone,
  Mic,
  Minus,
  Pencil,
  PlugZap,
  Plus,
  Radio,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Shield,
  ShieldCheck,
  SquareCode,
  Strikethrough,
  TextQuote,
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
} from "lucide-react";
import { localIcons } from "../../../../app/components/ui/icon-paths.tsx";

// The custom glyphs of the app (app/components/ui/icon-paths.tsx), imported as is.
export const LOCAL_ICONS = localIcons;

// Semantic name -> Lucide icon, as in app/components/ui/icon.tsx. A custom glyph wins when both have the name.
export const LUCIDE_ICONS = {
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
  bold: Bold,
  italic: Italic,
  strikethrough: Strikethrough,
  "list-bullet": List,
  "list-number": ListOrdered,
  quote: TextQuote,
  code: Code,
  "code-block": SquareCode,
  copy: Copy,
  external: ExternalLink,
  image: Image,
  crop: Crop,
  reset: RotateCcw,
  check: Check,
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
  layers: Layers,
  channels: PlugZap,
  reports: ChartLine,
  sync: RefreshCw,
  wifi: Wifi,
  "wifi-off": WifiOff,
  requests: Inbox,
  key: KeyRound,
  approve: UserCheck,
  reject: UserX,
  mail: Mail,
  globe: Globe,
  translate: Languages,
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
};

// Every icon name, custom glyphs first.
export const ICON_NAMES = [...new Set([...Object.keys(localIcons), ...Object.keys(LUCIDE_ICONS)])];

// Decorative currentColor icon, as in app/components/ui/icon.tsx; label the control. Sizes: 14, 16, 18, 20, 24, 40.
export function Icon({ name, size = 18, className = "" }) {
  const classes = `icon icon-${size} icon-${name} ${className}`.trim();
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
        {localIcons[name]}
      </svg>
    );
  const Lucide = LUCIDE_ICONS[name];
  if (!Lucide) return null;
  return <Lucide className={classes} size={size} strokeWidth={1.8} aria-hidden="true" focusable="false" />;
}

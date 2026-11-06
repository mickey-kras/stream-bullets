import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Toast as RadixToast } from "radix-ui";
import { t } from "../../i18n";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** An action such as Undo. A toast with an action stays for at least 10 s. */
  action?: ToastAction;
  /** Errors are announced assertively; everything else politely. */
  tone?: "status" | "error";
}

type ShowToast = (message: string, options?: ToastOptions) => void;

interface ToastState extends ToastOptions {
  id: number;
  message: string;
  open: boolean;
}

/** Undo and other actions stay at least this long (approved review round 13). */
export const ACTION_TOAST_MS = 10_000;

/** How long a toast stays: 5 s plus 60 ms per character (a11y M9), at least 10 s with an action. */
export function toastDuration(message: string, hasAction: boolean): number {
  const reading: number = 5000 + 60 * message.length;
  return hasAction ? Math.max(ACTION_TOAST_MS, reading) : reading;
}

const ToastContext = createContext<ShowToast>(() => undefined);

/** `const toast = useToast(); toast("Copied.")` or `toast("Topic deleted.", { action: { label: "Undo", onClick } })`. */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

/**
 * Keeps a slot for the visible toast in the page layout, just above the footer band, so the toast never
 * covers content: the page's scroll area shrinks by the toast's height while it shows.
 */
function useReservedSlot(viewport: RefObject<HTMLOListElement | null>, visible: boolean): void {
  useEffect(() => {
    const root: HTMLElement = document.documentElement;
    const element: HTMLOListElement | null = viewport.current;
    if (!element || !visible) {
      root.classList.remove("toast-on", "toast-nofoot");
      root.style.removeProperty("--toast-slot");
      return;
    }
    const sync = (): void => {
      const height: number = Math.ceil(element.getBoundingClientRect().height);
      const footer: HTMLElement | null = document.querySelector("body > .site-footer");
      const footerHeight: number = footer && getComputedStyle(footer).display !== "none" ? footer.offsetHeight : 0;
      root.classList.toggle("toast-on", height > 0);
      root.classList.toggle("toast-nofoot", footerHeight === 0);
      root.style.setProperty("--toast-slot", `${height + 16}px`);
      element.style.bottom = `${footerHeight + 8}px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.classList.remove("toast-on", "toast-nofoot");
      root.style.removeProperty("--toast-slot");
    };
  }, [viewport, visible]);
}

/**
 * Toasts on Radix Toast: one at a time, bottom centre in a reserved area that never covers content.
 * The timer pauses while the pointer is over the toast or focus is inside it (Radix), and F8 jumps to it.
 */
export function ToastProvider({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  const [toast, setToast] = useState<ToastState | null>(null);
  const viewport = useRef<HTMLOListElement | null>(null);
  const sequence = useRef<number>(0);
  const show: ShowToast = useCallback((message: string, options: ToastOptions = {}) => {
    sequence.current += 1;
    setToast({ id: sequence.current, message, open: true, ...options });
  }, []);
  useReservedSlot(viewport, Boolean(toast?.open));
  return (
    <ToastContext.Provider value={show}>
      <RadixToast.Provider label={t("toast.region")} swipeDirection="down">
        {children}
        {toast && (
          <RadixToast.Root
            key={toast.id}
            className={`sb-toast show${toast.action ? " has-action" : ""}${toast.tone === "error" ? " is-error" : ""}`}
            type={toast.tone === "error" ? "foreground" : "background"}
            duration={toastDuration(toast.message, Boolean(toast.action))}
            open={toast.open}
            onOpenChange={(open: boolean) => {
              if (!open) setToast((current: ToastState | null) => (current?.id === toast.id ? null : current));
            }}
          >
            <RadixToast.Description>{toast.message}</RadixToast.Description>
            {toast.action && (
              <RadixToast.Action className="toast-action" altText={toast.action.label} onClick={toast.action.onClick}>
                {toast.action.label}
              </RadixToast.Action>
            )}
          </RadixToast.Root>
        )}
        <RadixToast.Viewport ref={viewport} className="sb-toast-viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

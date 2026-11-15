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
  // Actions such as Undo remain at least 10 seconds.
  action?: ToastAction;
  // Errors announce assertively; other messages politely.
  tone?: "status" | "error";
}

type ShowToast = (message: string, options?: ToastOptions) => void;

interface ToastState extends ToastOptions {
  id: number;
  message: string;
  open: boolean;
}

// Minimum action duration.
export const ACTION_TOAST_MS = 10_000;

// Duration: 5 s + 60 ms/character; action minimum: 10 s.
export function toastDuration(message: string, hasAction: boolean): number {
  const reading: number = 5000 + 60 * message.length;
  return hasAction ? Math.max(ACTION_TOAST_MS, reading) : reading;
}

const ToastContext = createContext<ShowToast>(() => undefined);

// useToast()("Copied.") or toast("Deleted.", {action: {label: "Undo", onClick}}).
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

// Reserve toast height above the footer; shrink scrolling content instead of covering it.
function useReservedSlot(visible: boolean): RefObject<HTMLOListElement | null> {
  const viewport = useRef<HTMLOListElement | null>(null);
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
  }, [visible]);
  return viewport;
}

// One bottom-center Radix toast. Hover/focus pauses expiry; F8 focuses it.
export function ToastProvider({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  const [toast, setToast] = useState<ToastState | null>(null);
  const sequence = useRef<number>(0);
  const show: ShowToast = useCallback((message: string, options: ToastOptions = {}) => {
    sequence.current += 1;
    setToast({ id: sequence.current, message, open: true, ...options });
  }, []);
  const viewport = useReservedSlot(Boolean(toast?.open));
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

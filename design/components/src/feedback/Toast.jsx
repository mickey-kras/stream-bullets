import { Toast as RadixToast } from "radix-ui";

// Minimum duration of a toast with an action.
export const ACTION_TOAST_MS = 10_000;

// Duration: 5 s + 60 ms for each character; 10 s at least with an action (app/components/ui/toast.tsx).
export function toastDuration(message, hasAction) {
  const reading = 5000 + 60 * message.length;
  return hasAction ? Math.max(ACTION_TOAST_MS, reading) : reading;
}

// A static viewport for previews: the app viewport is fixed at the bottom center of the window.
const IN_FLOW = { position: "static", transform: "none", width: "auto", maxWidth: "100%", alignItems: "flex-start" };

// One Radix toast in its own viewport, as the app ToastProvider renders it.
export function Toast({
  message,
  tone = "status",
  action,
  floating = false,
  open = true,
  onOpenChange,
  duration,
  regionLabel = "Notifications",
  className = "",
}) {
  const error = tone === "error";
  return (
    <RadixToast.Provider label={regionLabel} swipeDirection="down">
      <RadixToast.Root
        className={`sb-toast show${action ? " has-action" : ""}${error ? " is-error" : ""} ${className}`.trim()}
        type={error ? "foreground" : "background"}
        duration={duration ?? (floating ? toastDuration(message, Boolean(action)) : Infinity)}
        open={open}
        onOpenChange={onOpenChange}
      >
        <RadixToast.Description>{message}</RadixToast.Description>
        {action && (
          <RadixToast.Action className="toast-action" altText={action.label} onClick={action.onClick}>
            {action.label}
          </RadixToast.Action>
        )}
      </RadixToast.Root>
      <RadixToast.Viewport className="sb-toast-viewport" style={floating ? undefined : IN_FLOW} />
    </RadixToast.Provider>
  );
}

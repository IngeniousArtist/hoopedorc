import {
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";

const SUPPORTED = typeof window !== "undefined" && "Notification" in window;
// B24: the Notification API requires a secure context (HTTPS or localhost).
// Over plain HTTP from another machine on the tailnet (the common remote
// setup before F20's tailscale-serve doc lands) it's simply unavailable —
// worth telling the user *why*, not just that it's "not supported".
const SECURE_CONTEXT =
  typeof window !== "undefined" && window.isSecureContext;

interface BrowserNotifyContextValue {
  supported: boolean;
  secureContext: boolean;
  /**
   * B24: some platforms (Android Chrome, notably) grant permission but
   * throw when the page itself constructs `new Notification(...)` — that
   * surface is restricted to `ServiceWorkerRegistration.showNotification`,
   * which this app doesn't use. Set once a real construction attempt (at
   * grant time, or from `notify`) has thrown, so Settings can show an
   * honest failure instead of a green "Enabled" that can never fire.
   */
  constructionFailed: boolean;
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  /**
   * Fires a native browser notification — but only when permission is
   * granted AND the tab is hidden. This is a background-only channel for
   * "you should look at this even though you're not looking at the tab
   * right now"; it's deliberately not a general-purpose alert mechanism (use
   * useToast for anything the user should see while the tab is focused).
   */
  notify: (title: string, options?: NotificationOptions) => void;
}

const BrowserNotifyContext = createContext<BrowserNotifyContextValue | null>(
  null,
);

export function BrowserNotifyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [permission, setPermission] = useState<NotificationPermission>(
    SUPPORTED ? Notification.permission : "denied",
  );
  const [constructionFailed, setConstructionFailed] = useState(false);

  const requestPermission = useCallback(async () => {
    if (!SUPPORTED) return "denied" as NotificationPermission;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") {
      // B24: probe construction immediately rather than waiting for the
      // first real notify() call (which only fires while the tab is
      // hidden, so a broken construction could otherwise go unnoticed for
      // the whole session) — doubles as a genuine "you're set up" ping.
      try {
        const n = new Notification("Hoopedorc notifications enabled", {
          body: "You'll see alerts here for approvals and task failures while this tab is hidden.",
          silent: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
        setConstructionFailed(false);
      } catch {
        setConstructionFailed(true);
      }
    }
    return result;
  }, []);

  const notify = useCallback(
    (title: string, options?: NotificationOptions) => {
      if (!SUPPORTED || permission !== "granted" || !document.hidden) return;
      try {
        const n = new Notification(title, options);
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        // Some contexts (e.g. Android Chrome, which restricts construction
        // to a service worker) throw here even with permission granted —
        // surface it the same way the grant-time probe does.
        setConstructionFailed(true);
      }
    },
    [permission],
  );

  return (
    <BrowserNotifyContext.Provider
      value={{
        supported: SUPPORTED,
        secureContext: SECURE_CONTEXT,
        constructionFailed,
        permission,
        requestPermission,
        notify,
      }}
    >
      {children}
    </BrowserNotifyContext.Provider>
  );
}

export function useBrowserNotify(): BrowserNotifyContextValue {
  const ctx = useContext(BrowserNotifyContext);
  if (!ctx) {
    throw new Error(
      "useBrowserNotify must be used within a BrowserNotifyProvider",
    );
  }
  return ctx;
}

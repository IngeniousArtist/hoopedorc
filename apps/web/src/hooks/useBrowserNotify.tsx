import {
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";

const SUPPORTED = typeof window !== "undefined" && "Notification" in window;

interface BrowserNotifyContextValue {
  supported: boolean;
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

  const requestPermission = useCallback(async () => {
    if (!SUPPORTED) return "denied" as NotificationPermission;
    const result = await Notification.requestPermission();
    setPermission(result);
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
        /* some contexts (e.g. insecure origin) throw on construction */
      }
    },
    [permission],
  );

  return (
    <BrowserNotifyContext.Provider
      value={{ supported: SUPPORTED, permission, requestPermission, notify }}
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

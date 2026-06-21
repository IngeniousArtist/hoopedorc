import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

interface Toast {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
}

interface ToastContextValue {
  toast: (message: string, kind?: Toast["kind"]) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLES: Record<Toast["kind"], string> = {
  success: "border-green-800 bg-green-950/90 text-green-200",
  error: "border-red-800 bg-red-950/90 text-red-200",
  info: "border-neutral-700 bg-neutral-900/90 text-neutral-200",
};

const DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const toast = useCallback(
    (message: string, kind: Toast["kind"] = "info") => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, DISMISS_MS);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 sm:w-auto">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={
              "rounded border px-3 py-2 text-xs shadow-lg " + KIND_STYLES[t.kind]
            }
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Fire-and-forget toast notification. Auto-dismisses after 5s. */
export function useToast(): ToastContextValue["toast"] {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx.toast;
}

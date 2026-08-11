import type { ReactNode } from "react";
import { useCallback, useId, useRef, useState } from "react";
import { Dialog } from "./Dialog";

type ConfirmationOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  tone?: "danger" | "warning";
  action: () => unknown | Promise<unknown>;
  errorMessage?: (error: unknown) => string;
};

type ConfirmationState = {
  options: ConfirmationOptions;
  pending: boolean;
  error: string | null;
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One confirmation transaction per owner. The action stays captured until it
 * succeeds or the operator cancels, so retries cannot lose caller input or
 * silently switch to a newer target underneath an open safety prompt.
 */
export function useConfirmation() {
  const [state, setState] = useState<ConfirmationState | null>(null);
  const stateRef = useRef<ConfirmationState | null>(null);

  const publish = useCallback((next: ConfirmationState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const requestConfirmation = useCallback(
    (options: ConfirmationOptions) => {
      if (stateRef.current) return;
      publish({ options, pending: false, error: null });
    },
    [publish],
  );

  const dismiss = useCallback(() => {
    if (stateRef.current?.pending) return;
    publish(null);
  }, [publish]);

  const confirm = useCallback(async () => {
    const current = stateRef.current;
    if (!current || current.pending) return;

    publish({ ...current, pending: true, error: null });
    try {
      await current.options.action();
      publish(null);
    } catch (error) {
      const latest = stateRef.current;
      if (!latest) return;
      publish({
        ...latest,
        pending: false,
        error:
          current.options.errorMessage?.(error) ??
          `The action failed: ${errorMessage(error)}`,
      });
    }
  }, [publish]);

  return {
    requestConfirmation,
    confirmationDialog: state ? (
      <ConfirmationDialog
        {...state}
        onCancel={dismiss}
        onConfirm={() => void confirm()}
      />
    ) : null,
  };
}

function ConfirmationDialog({
  options,
  pending,
  error,
  onCancel,
  onConfirm,
}: ConfirmationState & { onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmClass =
    options.tone === "warning"
      ? "bg-amber-600 text-neutral-950 hover:bg-amber-500"
      : "bg-red-700 text-white hover:bg-red-600";

  return (
    <Dialog
      labelledBy={titleId}
      describedBy={options.description ? descriptionId : undefined}
      onDismiss={onCancel}
      dismissDisabled={pending}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto border-0 bg-transparent p-0 text-neutral-100"
    >
      <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
        <h2 id={titleId} className="text-sm font-semibold text-neutral-100">
          {options.title}
        </h2>
        {options.description && (
          <div id={descriptionId} className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">
            {options.description}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-4 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-200"
          >
            <p>{error}</p>
            <p className="mt-1 text-red-300">
              Fix the issue, then try again or cancel without losing this confirmation.
            </p>
          </div>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            data-dialog-initial-focus
            onClick={onCancel}
            disabled={pending}
            className="min-h-10 rounded border border-neutral-700 px-4 py-2 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
            className={`min-h-10 rounded px-4 py-2 text-xs font-medium disabled:opacity-50 ${confirmClass}`}
          >
            {pending ? (options.pendingLabel ?? "Working…") : options.confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

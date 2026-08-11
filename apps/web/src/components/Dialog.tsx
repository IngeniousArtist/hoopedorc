import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useLayoutEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const dialogStack: HTMLDialogElement[] = [];
let openDialogCount = 0;
let previousDocumentOverflow = "";

function focusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}

function firstFocusTarget(
  dialog: HTMLDialogElement,
  initialFocusRef?: RefObject<HTMLElement>,
): HTMLElement {
  return (
    initialFocusRef?.current ??
    dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
    focusableElements(dialog)[0] ??
    dialog
  );
}

function isTopDialog(dialog: HTMLDialogElement): boolean {
  return dialogStack.at(-1) === dialog;
}

export function Dialog({
  labelledBy,
  describedBy,
  className,
  initialFocusRef,
  onDismiss,
  dismissDisabled = false,
  children,
}: {
  labelledBy: string;
  describedBy?: string;
  className: string;
  initialFocusRef?: RefObject<HTMLElement>;
  onDismiss?: () => void;
  dismissDisabled?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogStack.push(dialog);
    if (openDialogCount === 0) {
      previousDocumentOverflow = document.documentElement.style.overflow;
    }
    openDialogCount += 1;
    document.documentElement.style.overflow = "hidden";

    try {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } catch {
      // JSDOM and older embedded webviews may expose an incomplete dialog
      // implementation. The explicit semantics and focus guard below keep
      // the safety control operable instead of falling back to confirm().
      dialog.setAttribute("open", "");
    }

    firstFocusTarget(dialog, initialFocusRef).focus();

    const containProgrammaticFocus = (event: FocusEvent) => {
      if (!isTopDialog(dialog)) return;
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      firstFocusTarget(dialog, initialFocusRef).focus();
    };
    document.addEventListener("focusin", containProgrammaticFocus);

    return () => {
      document.removeEventListener("focusin", containProgrammaticFocus);
      const stackIndex = dialogStack.lastIndexOf(dialog);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");

      openDialogCount = Math.max(0, openDialogCount - 1);
      if (openDialogCount === 0) {
        document.documentElement.style.overflow = previousDocumentOverflow;
      }
      // An action may re-enable its trigger in the same React batch that
      // unmounts this dialog. Restore in the following microtask so focus()
      // cannot race the trigger's still-disabled DOM state.
      queueMicrotask(() => {
        if (returnFocus?.isConnected) returnFocus.focus();
      });
    };
  }, [initialFocusRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    const dialog = dialogRef.current;
    if (!dialog || !isTopDialog(dialog)) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!dismissDisabled) onDismiss?.();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (!dismissDisabled) onDismiss?.();
      }}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
      className={`hoop-dialog ${className}`}
    >
      {children}
    </dialog>
  );
}

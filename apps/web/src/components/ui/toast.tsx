"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconClose } from "./icons";
import { TRANSITION_COLORS } from "./transition";

export type ToastKind = "info" | "error";

type ToastItem = { id: number; message: string; kind: ToastKind };

type ToastContextValue = {
  show: (message: string, kind?: ToastKind) => void;
};

/** A scheduled auto-dismiss, and everything needed to pause and resume it. */
type Countdown = {
  timerId: ReturnType<typeof setTimeout> | null;
  /** Milliseconds still owed when the countdown was last paused. */
  remaining: number;
  /** `Date.now()` at which the current timer was started. */
  startedAt: number;
};

const ToastContext = createContext<ToastContextValue | null>(null);
const AUTO_DISMISS_MS = 4000;

/**
 * Minimal context provider — no portal library. Mount once near the app
 * root. No slide-in motion (nothing to disable for `prefers-reduced-motion`);
 * the global reduced-motion override in `globals.css` already zeroes any
 * opacity transition a future revision might add here.
 *
 * Two rules about time, both about not taking a message away from someone who
 * is still reading it:
 *
 * 1. **An error never auto-dismisses.** Four seconds is a glance; an error is
 *    the one message a person has to act on, and a failure that erases itself
 *    is the category's chronic sin (`docs/ux-patterns.md` §10.1) in miniature.
 *    Errors get no countdown at all and leave only by the Close button.
 * 2. **Hover or focus pauses every countdown.** A pointer resting on a toast,
 *    or focus reaching its Close button, means someone is reading or about to
 *    act. The countdown resumes with the time it had LEFT, not a fresh four
 *    seconds — a toast that restarts its clock on every accidental mouse pass
 *    is a different kind of lie about how long it will be there.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("Ui");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  // Every pending auto-dismiss countdown, keyed by toast id, so it can be
  // cancelled — on unmount below, and whenever its own toast is removed
  // early — instead of firing a setState after the provider is gone.
  const timers = useRef(new Map<number, Countdown>());

  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const countdown of timerMap.values()) {
        if (countdown.timerId !== null) clearTimeout(countdown.timerId);
      }
      timerMap.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const countdown = timers.current.get(id);
    if (countdown?.timerId != null) clearTimeout(countdown.timerId);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const start = useCallback(
    (id: number, ms: number) => {
      const countdown = timers.current.get(id);
      if (!countdown) return;
      countdown.remaining = ms;
      countdown.startedAt = Date.now();
      countdown.timerId = setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const show = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, kind }]);
      if (kind === "error") return;
      timers.current.set(id, { timerId: null, remaining: AUTO_DISMISS_MS, startedAt: Date.now() });
      start(id, AUTO_DISMISS_MS);
    },
    [start],
  );

  const pauseAll = useCallback(() => {
    for (const countdown of timers.current.values()) {
      if (countdown.timerId === null) continue;
      clearTimeout(countdown.timerId);
      countdown.timerId = null;
      // A toast whose remaining time ran out while the pointer was on it does
      // not vanish under that pointer; it leaves on resume, at `remaining` 0.
      countdown.remaining = Math.max(0, countdown.remaining - (Date.now() - countdown.startedAt));
    }
  }, []);

  const resumeAll = useCallback(() => {
    for (const [id, countdown] of timers.current) {
      if (countdown.timerId !== null) continue;
      start(id, Math.max(countdown.remaining, 0));
    }
  }, [start]);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Pause/resume live on the region, not each toast: moving the pointer
          between two stacked toasts would otherwise resume the one it left
          for the frame before it entered the next. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover here operates nothing — it only STOPS a timer, and the rule's concern (a pointer-only affordance) is answered by the onFocus/onBlur pair beside it, which does the same for the keyboard. Giving this container a role would put a second landmark around the toasts' own status/alert roles. */}
      <div
        onMouseEnter={pauseAll}
        onMouseLeave={resumeAll}
        onFocus={pauseAll}
        onBlur={resumeAll}
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-center gap-2 rounded-control border border-border bg-panel py-2.5 pr-2 pl-4 text-sm font-medium text-fg shadow-popover"
          >
            <span
              aria-hidden="true"
              className={[
                "h-1.5 w-1.5 shrink-0 rounded-full",
                toast.kind === "error" ? "bg-danger" : "bg-accent",
              ].join(" ")}
            />
            {toast.message}
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label={t("close")}
              className={`shrink-0 rounded-control p-1 text-fg-tertiary ${TRANSITION_COLORS} hover:bg-bg-sunken hover:text-fg`}
            >
              <IconClose size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type ToastKind = "info" | "error";

type ToastItem = { id: number; message: string; kind: ToastKind };

type ToastContextValue = {
  show: (message: string, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);
const AUTO_DISMISS_MS = 4000;

/**
 * Minimal context provider — no portal library. Mount once near the app
 * root. No slide-in motion (nothing to disable for `prefers-reduced-motion`);
 * the global reduced-motion override in `globals.css` already zeroes any
 * opacity transition a future revision might add here.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string, kind: ToastKind = "info") => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, kind }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-center gap-2 rounded-control border border-border bg-panel px-4 py-2.5 text-sm font-medium text-fg shadow-popover"
          >
            <span
              aria-hidden="true"
              className={[
                "h-1.5 w-1.5 shrink-0 rounded-full",
                toast.kind === "error" ? "bg-danger" : "bg-accent",
              ].join(" ")}
            />
            {toast.message}
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

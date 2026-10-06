"use client";

import { useRef } from "react";
import { buttonClasses } from "@/components/ui/button";

export type ComposerState = "saved" | "unsaved" | "conflict" | "saving";

export function composerTabId(prefix: string, adaptationId: string): string {
  return `${prefix}-tab-${adaptationId}`;
}

export function composerPanelId(prefix: string, adaptationId: string): string {
  return `${prefix}-panel-${adaptationId}`;
}

/** Channel drafts belong to the parent; choosing a tab only changes visibility. */
export function ComposerTabs({
  idPrefix,
  label,
  tabs,
  selected,
  onSelect,
}: {
  idPrefix: string;
  label: string;
  tabs: { id: string; label: string; state: ComposerState; stateLabel: string }[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  return (
    <div role="tablist" aria-label={label} className="mb-3 flex flex-wrap gap-2">
      {tabs.map((tab, index) => (
        <button
          type="button"
          key={tab.id}
          ref={(button) => {
            if (button) buttons.current.set(tab.id, button);
            else buttons.current.delete(tab.id);
          }}
          id={composerTabId(idPrefix, tab.id)}
          role="tab"
          aria-selected={selected === tab.id}
          aria-controls={composerPanelId(idPrefix, tab.id)}
          tabIndex={selected === tab.id ? 0 : -1}
          className={buttonClasses(
            "secondary",
            "md",
            [
              "h-auto min-h-11 min-w-11 flex-wrap py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              selected === tab.id ? "border-accent bg-bg-sunken" : "",
            ].join(" "),
          )}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            )
              return;
            const nextIndex =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index - 1 + tabs.length) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : null;
            if (nextIndex === null) return;
            event.preventDefault();
            const next = tabs[nextIndex];
            if (!next) return;
            onSelect(next.id);
            buttons.current.get(next.id)?.focus();
          }}
        >
          <span>{tab.label}</span>
          {tab.state !== "saved" && (
            <span
              className={
                tab.state === "conflict" ? "text-xs text-danger" : "text-xs text-fg-secondary"
              }
            >
              {tab.stateLabel}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

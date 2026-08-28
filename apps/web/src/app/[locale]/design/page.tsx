"use client";

/**
 * Dev-only component gallery: every `components/ui/*` component in every
 * documented variant/state, light and dark side by side. Kept out of
 * production by the `notFound()` call below (verified with
 * `pnpm --filter @pubrick/web build && next start`: `/en/design` 404s).
 *
 * All labels on this page are hardcoded English — allowed ONLY here per the
 * plan brief: the route never ships, is not user-facing, and adding
 * translation keys for throwaway sample copy ("Weekly roundup…", "Cancel")
 * would just be noise in every locale file.
 */

import { notFound } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Advanced, type AdvancedProps } from "@/components/ui/advanced";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  IconBrands,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCompose,
  IconExternal,
  IconMonitor,
  IconMoon,
  IconPlus,
  type IconProps,
  IconQueue,
  IconSearch,
  IconSettings,
  IconSun,
  IconUser,
  IconWarning,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusBadgeStatus } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { ToastProvider, useToast } from "@/components/ui/toast";

const ICONS: Array<{ name: string; Icon: (props: IconProps) => ReactNode }> = [
  { name: "queue", Icon: IconQueue },
  { name: "brands", Icon: IconBrands },
  { name: "settings", Icon: IconSettings },
  { name: "compose", Icon: IconCompose },
  { name: "search", Icon: IconSearch },
  { name: "plus", Icon: IconPlus },
  { name: "chevron-down", Icon: IconChevronDown },
  { name: "chevron-right", Icon: IconChevronRight },
  { name: "close", Icon: IconClose },
  { name: "check", Icon: IconCheck },
  { name: "warning", Icon: IconWarning },
  { name: "external", Icon: IconExternal },
  { name: "user", Icon: IconUser },
  { name: "moon", Icon: IconMoon },
  { name: "sun", Icon: IconSun },
  { name: "monitor", Icon: IconMonitor },
];

const BUTTON_VARIANTS: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
const BUTTON_SIZES: ButtonSize[] = ["md", "sm"];
const STATUSES: StatusBadgeStatus[] = ["draft", "review", "scheduled", "published", "failed"];

const NAV_SECTIONS = [
  { id: "icons", label: "Icons" },
  { id: "buttons", label: "Buttons" },
  { id: "inputs", label: "Inputs" },
  { id: "segmented", label: "Segmented" },
  { id: "status-badges", label: "Status badges" },
  { id: "cards", label: "Cards" },
  { id: "list-rows", label: "List rows" },
  { id: "empty-state", label: "Empty state" },
  { id: "skeleton", label: "Skeleton" },
  { id: "menu", label: "Menu" },
  { id: "modal", label: "Modal" },
  { id: "toast", label: "Toast" },
  { id: "advanced", label: "Advanced" },
];

function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className="scroll-mt-24 border-t border-border-soft pt-8 first:border-t-0 first:pt-0"
    >
      <h2 className="mb-4 text-base font-semibold text-fg">{title}</h2>
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  );
}

function SegmentedDemo() {
  const [value, setValue] = useState("all");
  return (
    <Segmented
      value={value}
      onChange={setValue}
      options={[
        { value: "all", label: "All" },
        { value: "draft", label: "Draft" },
        { value: "published", label: "Published" },
      ]}
    />
  );
}

function TextareaDemo() {
  const [value, setValue] = useState("Shipping the new gallery today.");
  return (
    <Textarea
      label="Post body"
      showCount
      maxLength={280}
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

function MenuDemo() {
  return (
    <Menu
      trigger={
        // `Menu` wraps `trigger` in its own <button> (see menu.tsx), so the
        // trigger content itself must not be a <Button> — that would nest
        // interactive <button>s, which is invalid HTML and broke hydration
        // when first tried here. This <span> just borrows Button's
        // secondary/sm classes to look the same.
        <span className="inline-flex h-[30px] items-center justify-center gap-2 rounded-control border border-border bg-panel px-3 text-sm font-semibold text-fg transition-colors hover:bg-bg-sunken">
          Actions <IconChevronDown size={16} />
        </span>
      }
      items={[
        { label: "Duplicate", onSelect: () => {} },
        { label: "Archive", onSelect: () => {} },
        { label: "Delete", onSelect: () => {}, danger: true },
      ]}
    />
  );
}

function ModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" onClick={() => setOpen(true)}>
        Open modal (live)
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete this post?"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={() => setOpen(false)}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">This can&rsquo;t be undone.</p>
      </Modal>
      {/*
       * Modal renders through `fixed inset-0`, so triggering a real "open"
       * instance for both the light and dark columns at once would cover
       * the whole viewport and break the side-by-side layout — the brief
       * explicitly allows a static, in-flow preview instead. This reuses
       * Modal's own class strings so it's an honest visual match, it just
       * isn't wired to Escape/backdrop-click/focus-trap like the live one
       * above (click "Open modal (live)" to exercise that behavior).
       */}
      <div className="max-w-[480px] overflow-hidden rounded-card-lg border border-border bg-panel shadow-popover">
        <div className="flex items-center justify-between gap-4 border-b border-border-soft px-5 py-4">
          <h3 className="text-[17px] font-semibold text-fg">Delete this post?</h3>
          <IconClose size={16} className="text-fg-tertiary" />
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-fg-secondary">This can&rsquo;t be undone.</p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border-soft px-5 py-4">
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="danger" size="sm">
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function ToastTriggers() {
  const { show } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => show("Draft saved.")}>
        Show info toast
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => show("Publish failed — retrying.", "error")}
      >
        Show error toast
      </Button>
    </div>
  );
}

function ToastDemo() {
  return (
    // Own provider per column: `useToast` needs one, and it keeps the
    // light/dark triggers independent. Its toast list still renders through
    // a `fixed inset-x-0 bottom-4` div (see toast.tsx), so a shown toast is
    // pinned to the real viewport bottom rather than inside this column —
    // expected here, not a bug in this page.
    <ToastProvider>
      <ToastTriggers />
    </ToastProvider>
  );
}

function AdvancedExpanded({ children, ...props }: AdvancedProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // `Advanced` wraps a native <details> and only exposes `dirty` — no
    // controlled/`open` prop to force it starting expanded. Rather than fork
    // the component just for this gallery, reach into the DOM once after
    // mount so the "expanded" state still renders honestly.
    const details = wrapperRef.current?.querySelector("details");
    if (details) details.open = true;
  }, []);

  return (
    <div ref={wrapperRef}>
      <Advanced {...props}>{children}</Advanced>
    </div>
  );
}

function GallerySections({ withAnchors }: { withAnchors: boolean }) {
  const id = (value: string) => (withAnchors ? value : undefined);

  return (
    <>
      <Section id={id("icons")} title="Icons">
        <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
          {ICONS.map(({ name, Icon }) => (
            <div
              key={name}
              className="flex flex-col items-center gap-1.5 rounded-control border border-border-soft bg-panel py-3"
            >
              <Icon size={20} />
              <span className="text-[11px] text-fg-tertiary">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id={id("buttons")} title="Buttons">
        <div className="flex flex-col gap-3">
          {BUTTON_VARIANTS.map((variant) => (
            <div key={variant} className="flex flex-wrap items-center gap-3">
              <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary">
                {variant}
              </span>
              {BUTTON_SIZES.map((size) => (
                <div key={size} className="flex items-center gap-2">
                  <Button variant={variant} size={size}>
                    Label
                  </Button>
                  <Button variant={variant} size={size} disabled>
                    Label
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section id={id("inputs")} title="Inputs">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Channel name" placeholder="e.g. Product updates" />
          <Input label="Channel name (disabled)" defaultValue="Product updates" disabled />
          <TextareaDemo />
          <Select label="Platform" defaultValue="telegram">
            <option value="telegram">Telegram</option>
            <option value="vk">VK</option>
            <option value="dzen">Dzen</option>
          </Select>
        </div>
      </Section>

      <Section id={id("segmented")} title="Segmented">
        <SegmentedDemo />
      </Section>

      <Section id={id("status-badges")} title="Status badges">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <StatusBadge key={status} status={status}>
              {status}
            </StatusBadge>
          ))}
        </div>
      </Section>

      <Section id={id("cards")} title="Cards">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <p className="text-sm font-semibold text-fg">Padded card</p>
            <p className="text-sm text-fg-secondary">Default padding — the common case.</p>
          </Card>
          <Card padded={false}>
            <div className="p-4">
              <p className="text-sm font-semibold text-fg">Unpadded card</p>
              <p className="text-sm text-fg-secondary">Caller owns the inner spacing.</p>
            </div>
          </Card>
        </div>
      </Section>

      <Section id={id("list-rows")} title="List rows">
        <div className="overflow-hidden rounded-card border border-border bg-panel">
          <ListRow
            title="Weekly roundup: what shipped"
            meta="Telegram · 2 hours ago"
            trailing={<StatusBadge status="published">published</StatusBadge>}
            href="#"
          />
          <ListRow
            title="Draft without a channel yet"
            meta="No channel assigned"
            trailing={<StatusBadge status="draft">draft</StatusBadge>}
          />
        </div>
      </Section>

      <Section id={id("empty-state")} title="Empty state">
        <Card padded={false}>
          <EmptyState
            icon={<IconSearch size={22} />}
            title="No posts match this filter."
            action={
              <Button size="sm" variant="secondary">
                Clear filter
              </Button>
            }
          />
        </Card>
      </Section>

      <Section id={id("skeleton")} title="Skeleton">
        <Card>
          <Skeleton lines={3} />
        </Card>
      </Section>

      <Section id={id("menu")} title="Menu">
        <MenuDemo />
      </Section>

      <Section id={id("modal")} title="Modal">
        <ModalDemo />
      </Section>

      <Section id={id("toast")} title="Toast">
        <ToastDemo />
      </Section>

      <Section id={id("advanced")} title="Advanced">
        <div className="flex flex-col gap-4">
          <Advanced label="Advanced options">
            <p className="text-sm text-fg-secondary">Nothing changed from the default.</p>
          </Advanced>
          <AdvancedExpanded label="Advanced options">
            <p className="text-sm text-fg-secondary">
              Forced open via DOM to show its contents — see the comment above AdvancedExpanded.
            </p>
          </AdvancedExpanded>
          <Advanced label="Advanced options" dirty>
            <p className="text-sm text-fg-secondary">
              A brick dot marks a non-default value while collapsed.
            </p>
          </Advanced>
        </div>
      </Section>
    </>
  );
}

export default function DesignGalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="min-h-dvh bg-bg pb-24">
      <nav className="sticky top-0 z-10 flex flex-wrap gap-x-4 gap-y-1 border-b border-border bg-bg/95 px-6 py-3 backdrop-blur">
        {NAV_SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="text-xs font-medium text-fg-secondary hover:text-accent"
          >
            {section.label}
          </a>
        ))}
      </nav>
      <div className="px-6 py-8">
        <h1 className="mb-1 text-2xl font-semibold text-fg">Component gallery</h1>
        <p className="mb-8 max-w-2xl text-sm text-fg-secondary">
          Every components/ui/* component in every documented variant, light and dark side by side.
          Dev-only — this route 404s in production builds.
        </p>
        <div className="grid gap-8 lg:grid-cols-2">
          <div
            data-theme="light"
            className="gallery-light flex flex-col gap-8 rounded-card-lg border border-border bg-bg-sunken p-6"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary">Light</p>
            <GallerySections withAnchors={true} />
          </div>
          <div
            data-theme="dark"
            className="gallery-dark flex flex-col gap-8 rounded-card-lg border border-border bg-bg-sunken p-6"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary">Dark</p>
            <GallerySections withAnchors={false} />
          </div>
        </div>
      </div>
    </main>
  );
}

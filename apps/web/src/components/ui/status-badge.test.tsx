import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./status-badge";

const ALL_STATUSES = ["draft", "review", "scheduled", "published", "failed"] as const;

describe("StatusBadge", () => {
  it.each(ALL_STATUSES)("status=%s uses only its own --status-%s-* token pair", (status) => {
    render(<StatusBadge status={status}>Label</StatusBadge>);
    const badge = screen.getByText("Label");

    expect(badge.className).toContain(`var(--status-${status}-bg)`);
    expect(badge.className).toContain(`var(--status-${status}-fg)`);

    // Mutation guard: a badge mapped to the wrong entry (or a shared default)
    // would still pass a bare "contains its own pair" check if the mapping
    // table degenerates to one shared value — so also assert every OTHER
    // status's pair is absent.
    for (const other of ALL_STATUSES) {
      if (other === status) continue;
      expect(badge.className).not.toContain(`--status-${other}-bg`);
      expect(badge.className).not.toContain(`--status-${other}-fg`);
    }
  });

  it("renders its children", () => {
    render(<StatusBadge status="published">Live</StatusBadge>);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("rejects a sixth status value outside the union at compile time", () => {
    function invalidUsage() {
      // @ts-expect-error - "archived" is not one of the five allowed statuses
      return <StatusBadge status="archived">Nope</StatusBadge>;
    }
    expect(typeof invalidUsage).toBe("function");
  });
});

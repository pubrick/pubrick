import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Textarea } from "./textarea";

/** The counter needs a live value, so tests drive a small controlled wrapper. */
function ControlledTextarea(props: { maxLength?: number; showCount?: boolean; initial?: string }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <Textarea
      label="Body"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      maxLength={props.maxLength}
      showCount={props.showCount}
    />
  );
}

describe("Textarea", () => {
  it("puts maxLength on the underlying <textarea> so the browser enforces the limit", () => {
    render(<ControlledTextarea maxLength={4096} showCount />);
    expect(screen.getByLabelText("Body")).toHaveAttribute("maxlength", "4096");
  });

  it("omits the maxlength attribute entirely when no maxLength prop is given", () => {
    render(<ControlledTextarea showCount />);
    expect(screen.getByLabelText("Body")).not.toHaveAttribute("maxlength");
  });

  it("renders the counter as `<length> / <maxLength>` and updates it as the user types", () => {
    render(<ControlledTextarea maxLength={4096} showCount />);
    expect(screen.getByTestId("char-count")).toHaveTextContent("0 / 4096");

    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Hello world" } });

    expect(screen.getByTestId("char-count")).toHaveTextContent("11 / 4096");
  });

  it("does not render a counter when showCount is false, even with maxLength set", () => {
    render(<ControlledTextarea maxLength={4096} showCount={false} />);
    expect(screen.queryByTestId("char-count")).not.toBeInTheDocument();
  });

  it("does not render a counter when maxLength is unset, even with showCount true", () => {
    render(<ControlledTextarea showCount />);
    expect(screen.queryByTestId("char-count")).not.toBeInTheDocument();
  });
});

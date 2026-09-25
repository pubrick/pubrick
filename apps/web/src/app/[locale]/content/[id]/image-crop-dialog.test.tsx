import userEvent from "@testing-library/user-event";
import type { HTMLAttributes, ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import es from "../../../../../messages/es.json";
import { ImageCropDialog } from "./image-crop-dialog";

vi.mock("react-easy-crop", () => ({
  default: ({
    mediaProps,
    cropperProps,
    onCropComplete,
  }: {
    mediaProps: ImgHTMLAttributes<HTMLImageElement>;
    cropperProps: HTMLAttributes<HTMLDivElement>;
    onCropComplete: (
      percent: unknown,
      pixels: { x: number; y: number; width: number; height: number },
    ) => void;
  }) => (
    <>
      {/* biome-ignore lint/performance/noImgElement: test deliberately exercises the library's image error callback */}
      <img src="/api/media/source/file" alt="" data-testid="source" {...mediaProps} />
      <div {...cropperProps} />
      <button type="button" onClick={() => onCropComplete({}, { x: 1, y: 2, width: 3, height: 4 })}>
        Mock crop complete
      </button>
    </>
  ),
}));

describe("article crop dialog", () => {
  it("names the keyboard crop frame and shows a localized source failure", async () => {
    const onSave = vi.fn();
    render(<ImageCropDialog mediaId="source" busy={false} onCancel={() => {}} onSave={onSave} />, {
      locale: "es",
    });
    const frame = screen.getByRole("group", { name: es.InlineImages.cropFrame });
    expect(frame).toHaveAccessibleDescription(es.InlineImages.cropKeyboardHint);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mock crop complete" }));
    expect(screen.getByRole("button", { name: es.InlineImages.cropSave })).toBeEnabled();
    fireEvent.error(screen.getByTestId("source"));
    expect(screen.getByRole("alert")).toHaveTextContent(es.InlineImages.cropSourceUnavailable);
    expect(screen.getByRole("button", { name: es.InlineImages.cropSave })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

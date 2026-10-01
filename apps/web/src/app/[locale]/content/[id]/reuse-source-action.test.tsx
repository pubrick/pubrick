import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
import { ReuseSourceAction } from "./reuse-source-action";

describe("saved source navigation", () => {
  it("navigates immediately only when the master is already saved", async () => {
    const navigate = vi.fn();
    const save = vi.fn();
    render(<ReuseSourceAction dirty={false} busy={false} save={save} navigate={navigate} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.Reuse.action }));
    expect(navigate).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
  it("failed save preserves the editor; successful save establishes the source before navigation", async () => {
    const navigate = vi.fn();
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const user = userEvent.setup();
    render(<ReuseSourceAction dirty busy={false} save={save} navigate={navigate} />);
    await user.click(screen.getByRole("button", { name: en.Reuse.action }));
    await user.click(screen.getByRole("button", { name: en.Reuse.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Reuse.saveFailed);
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: en.Reuse.save }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  });
  it("cancel stays put; explicit discard navigates without writing or generating", async () => {
    const save = vi.fn();
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<ReuseSourceAction dirty busy={false} save={save} navigate={navigate} />);
    await user.click(screen.getByRole("button", { name: en.Reuse.action }));
    await user.click(screen.getByRole("button", { name: en.Reuse.cancel }));
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: en.Reuse.action }));
    await user.click(screen.getByRole("button", { name: en.Reuse.discard }));
    expect(navigate).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
});

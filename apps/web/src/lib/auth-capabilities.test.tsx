import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { useAuthCapabilities } from "./auth-capabilities";

function Probe() {
  const caps = useAuthCapabilities();
  return (
    <>
      <p>{caps.ready ? caps.deploymentMode : "blocked"}</p>
      {caps.failed && (
        <button type="button" onClick={caps.retry}>
          Retry
        </button>
      )}
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
it("refuses to infer self-hosted mutation rights from incomplete capabilities", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({ requiresEmailVerification: false, passwordRecoveryEnabled: false }),
    ),
  );
  render(<Probe />);
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByText("blocked")).toBeInTheDocument();
});
it("recovers after a failed capability read, activating only explicit validated hosted mode", async () => {
  vi.mocked(fetch)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          requiresEmailVerification: true,
          passwordRecoveryEnabled: true,
          deploymentMode: "hosted",
          billingEnabled: true,
          billingTestMode: true,
        }),
      ),
    );
  render(<Probe />);
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("hosted")).toBeInTheDocument();
});

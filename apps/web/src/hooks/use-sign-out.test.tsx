import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useSignOut } from "@/hooks/use-sign-out";
import { authClient, resetStubSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor } from "@/test/render";

function SignOutProbe() {
  const signOut = useSignOut();
  return (
    <button type="button" onClick={() => void signOut()}>
      leave
    </button>
  );
}

beforeEach(() => {
  resetStubSession();
  authClient.signOut.mockReset();
});

describe("useSignOut", () => {
  it("ends the session and then leaves for the login screen", async () => {
    authClient.signOut.mockResolvedValue(undefined);
    render(<SignOutProbe />);

    await userEvent.setup().click(screen.getByRole("button", { name: "leave" }));

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/en/login"));
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
  });

  it("does not navigate before the session has actually been ended", async () => {
    // The whole defect was a sign-out that left the person on the page. The
    // inverse — navigating first and hoping the request lands — would leave a
    // live cookie behind, so the order is asserted, not just the pair.
    let endSession!: () => void;
    authClient.signOut.mockReturnValue(
      new Promise<void>((resolve) => {
        endSession = resolve;
      }),
    );
    render(<SignOutProbe />);

    await userEvent.setup().click(screen.getByRole("button", { name: "leave" }));

    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).not.toHaveBeenCalled();

    endSession();
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/en/login"));
  });

  it("replaces rather than pushes, so Back cannot return to the signed-in page", async () => {
    authClient.signOut.mockResolvedValue(undefined);
    render(<SignOutProbe />);

    await userEvent.setup().click(screen.getByRole("button", { name: "leave" }));

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

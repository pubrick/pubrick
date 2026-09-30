import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { BillingStatus } from "@/lib/billing";
import { render, screen } from "@/test/render";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";
import { BillingCard } from "./billing-card";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
const knownUsage = { seats: 1, brands: 2, channels: 1, mediaBytes: 1048576, concurrentJobs: 0 };
const status: BillingStatus = {
  mode: "test",
  funding: "byok",
  status: "unconfigured",
  plan: null,
  limits: null,
  usage: knownUsage,
  accessUntil: null,
  cancelAtPeriodEnd: false,
  canManage: true,
  checkoutAvailable: true,
  portalAvailable: true,
};
beforeEach(() => {
  vi.mocked(api).mockReset();
});
it("labels sandbox, uses actual usage, and gives no dead purchase button without a catalog", async () => {
  vi.mocked(api).mockImplementation(async (path) => (path.endsWith("plans") ? [] : status));
  render(<BillingCard orgId="org1" testMode />);
  expect(await screen.findByText(en.BillingCard.noPlans)).toBeInTheDocument();
  expect(screen.getByText(en.BillingCard.sandbox)).toBeInTheDocument();
  expect(screen.getByText("1 MiB")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: en.BillingCard.checkout })).not.toBeInTheDocument();
});
it("uses only server-confirmed subscription state even when checkout is pending", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith("plans")
      ? [
          {
            id: "basic",
            version: 1,
            limits: knownUsage,
            currency: "USD",
            unitAmount: 2000,
            interval: "month",
            intervalCount: 1,
          },
        ]
      : { ...status, status: "pending" },
  );
  render(<BillingCard orgId="org1" testMode />);
  expect(await screen.findByText(en.BillingCard.pendingHelp)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: en.BillingCard.checkout })).toBeDisabled();
  expect(screen.queryByText(en.BillingCard.status_active)).not.toBeInTheDocument();
});
it("makes loading failures recoverable and retains export guidance for expired access", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith("plans")
      ? []
      : { ...status, status: "expired", plan: { id: "basic", version: 1 } },
  );
  render(<BillingCard orgId="org1" testMode />);
  expect(await screen.findByRole("alert")).toHaveTextContent(en.BillingCard.error);
  await userEvent.click(screen.getByRole("button", { name: en.BillingCard.refresh }));
  expect(await screen.findByText(en.BillingCard.expiredHelp)).toBeInTheDocument();
});

it("never offers actionable checkout when the fixture driver has no payment destination", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith("plans")
      ? [
          {
            id: "basic",
            version: 1,
            limits: knownUsage,
            currency: "USD",
            unitAmount: 2000,
            interval: "month",
            intervalCount: 1,
          },
        ]
      : { ...status, checkoutAvailable: false },
  );
  render(<BillingCard orgId="org1" testMode />);
  const action = await screen.findByRole("button", { name: en.BillingCard.checkout });
  expect(action).toBeDisabled();
  await userEvent.click(action);
  expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith("checkout"))).toBe(false);
});

it.each([
  ["en", en],
  ["es", es],
  ["pt", pt],
  ["ru", ru],
] as const)(
  "keeps known subscription management available with unknown storage in %s",
  async (locale, messages) => {
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith("plans")
        ? []
        : {
            ...status,
            status: "active",
            plan: { id: "basic", version: 1 },
            usage: { ...status.usage, mediaBytes: null },
          },
    );
    render(<BillingCard orgId="org-unknown-storage" testMode />, { locale });
    expect(
      await screen.findByText(messages.BillingCard.usageUnknown, { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(messages.BillingCard.status_active, { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: messages.BillingCard.portal })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(messages.BillingCard.storageUnknownHelp);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("0 MiB")).not.toBeInTheDocument();
  },
);

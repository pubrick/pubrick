import { brandImportApplySchema, brandImportRequestSchema, refusalBody } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/test/render";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import { BrandImport } from "./brand-import";

const brandId = "11111111-1111-4111-8111-111111111111";
const suggestion = {
  name: "Acme",
  description: "Makes coffee",
  voice: "Plain and warm",
  audience: "Café owners",
  contentLanguage: "en",
  topics: ["Roasting", "Storage"],
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("brand profile import", () => {
  it("does not write until review and sends only selected edited ideas", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url, body });
        return url.endsWith("/preview")
          ? response(201, { sourceUrl: "https://example.com", suggestion })
          : response(201, { id: brandId });
      }),
    );
    const applied = vi.fn();
    render(<BrandImport brandId={brandId} onApplied={applied} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Brands.importOpen }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: en.Brands.importUrl }),
      "https://example.com",
    );
    expect(calls).toHaveLength(0);
    await user.click(within(dialog).getByRole("checkbox", { name: en.Brands.importCostConsent }));
    await user.click(within(dialog).getByRole("button", { name: en.Brands.importPreview }));
    expect(calls).toEqual([
      {
        url: `/api/brands/${brandId}/import/preview`,
        body: { url: "https://example.com", acceptAiCost: true },
      },
    ]);
    expect(brandImportRequestSchema.parse(calls[0]?.body)).toEqual(calls[0]?.body);
    expect(applied).not.toHaveBeenCalled();

    const name = await within(dialog).findByRole("textbox", { name: en.Brands.nameLabel });
    await user.clear(name);
    await user.type(name, "Edited Acme");
    await user.click(within(dialog).getByRole("checkbox", { name: "Include idea 2" }));
    await user.click(within(dialog).getByRole("button", { name: en.Brands.voiceSave }));
    expect(calls[1]).toEqual({
      url: `/api/brands/${brandId}/import/apply`,
      body: { ...suggestion, name: "Edited Acme", topics: ["Roasting"] },
    });
    expect(brandImportApplySchema.parse(calls[1]?.body)).toEqual(calls[1]?.body);
    expect(applied).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: en.Brands.importOpen }));
    const reopened = screen.getByRole("dialog");
    expect(
      within(reopened).getByRole("checkbox", { name: en.Brands.importCostConsent }),
    ).not.toBeChecked();
    expect(within(reopened).getByRole("button", { name: en.Brands.importPreview })).toBeDisabled();
  });

  it("keeps an in-flight paid preview visible until its result arrives", async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );
    render(<BrandImport brandId={brandId} onApplied={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Brands.importOpen }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: en.Brands.importUrl }),
      "https://example.com",
    );
    await user.click(within(dialog).getByRole("checkbox", { name: en.Brands.importCostConsent }));
    await user.click(within(dialog).getByRole("button", { name: en.Brands.importPreview }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    release(response(201, { sourceUrl: "https://example.com", suggestion }));
    expect(await within(dialog).findByRole("textbox", { name: en.Brands.nameLabel })).toHaveValue(
      "Acme",
    );
  });

  it("shows a coded refusal in Spanish and leaves the preview unsaved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(400, refusalBody(400, "brand_import_no_google_key", "Add a key"))),
    );
    const applied = vi.fn();
    render(<BrandImport brandId={brandId} onApplied={applied} />, { locale: "es" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: es.Brands.importOpen }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: es.Brands.importUrl }),
      "https://example.com",
    );
    await user.click(within(dialog).getByRole("checkbox", { name: es.Brands.importCostConsent }));
    await user.click(within(dialog).getByRole("button", { name: es.Brands.importPreview }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      es.Errors.brand_import_no_google_key,
    );
    expect(applied).not.toHaveBeenCalled();
  });
});

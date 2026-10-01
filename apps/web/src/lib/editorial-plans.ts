import type {
  EditorialPlanCreate,
  EditorialPlanEnable,
  EditorialPlanOccurrencesPage,
  EditorialPlanPreview,
  EditorialPlanPreviewResult,
  EditorialPlanSummary,
  EditorialPlanUpdate,
} from "@pubrick/shared";
import { api } from "./api";

const base = "/api/calendar/editorial-plans";
const scoped = (brandId: string, path = "") =>
  `${base}${path}?brandId=${encodeURIComponent(brandId)}`;
export const editorialPlans = {
  list: (brandId: string) => api<EditorialPlanSummary[]>(scoped(brandId)),
  create: (body: EditorialPlanCreate) =>
    api<EditorialPlanSummary>(base, { method: "POST", body: JSON.stringify(body) }),
  preview: (brandId: string, body: EditorialPlanPreview) =>
    api<EditorialPlanPreviewResult>(scoped(brandId, "/preview"), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (brandId: string, id: string, body: EditorialPlanUpdate) =>
    api<EditorialPlanSummary>(scoped(brandId, `/${id}`), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  enable: (brandId: string, id: string, body: EditorialPlanEnable) =>
    api<EditorialPlanSummary>(scoped(brandId, `/${id}/enable`), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  pause: (brandId: string, id: string, expectedRevision: number) =>
    api<EditorialPlanSummary>(scoped(brandId, `/${id}/pause`), {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }),
  remove: (brandId: string, id: string, expectedRevision: number) =>
    api<{ removed: true; revision: number }>(scoped(brandId, `/${id}`), {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision }),
    }),
  history: (brandId: string, id: string, cursor?: string) =>
    api<EditorialPlanOccurrencesPage>(
      `${scoped(brandId, `/${id}/occurrences`)}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
};

/** Format the server's offset value, including historical IANA seconds; timezone calculation stays server-side. */
export function editorialPlanUtcOffset(minutes: number): string {
  const seconds = Math.round(Math.abs(minutes) * 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `UTC${minutes < 0 ? "−" : "+"}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}${seconds % 60 ? `:${pad(seconds % 60)}` : ""}`;
}

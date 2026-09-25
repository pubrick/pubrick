"use client";

import {
  type ContentImagesState,
  type DraftRevisionProposal,
  draftRevisionRequestSchema,
  type EditorialNoteDto,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, apiPage, apiVoid, errorMessage } from "@/lib/api";

/** A paid whole-draft suggestion never changes saved text until Accept. */
export function DraftRevision({
  itemId,
  currentTitle,
  currentBody,
  coverMediaId,
  draftBody,
  eligible,
  staged,
  onAccepted,
}: {
  itemId: string;
  currentTitle: string | null;
  currentBody: string;
  coverMediaId: string | null;
  draftBody: string;
  eligible: boolean;
  staged: DraftRevisionProposal | null;
  onAccepted: (body: string, title: string | null) => Promise<void>;
}) {
  const t = useTranslations("DraftRevision");
  const te = useTranslations("Errors");
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<"instruction" | "note">("instruction");
  const [notes, setNotes] = useState<EditorialNoteDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [noteId, setNoteId] = useState("");
  const [proposal, setProposal] = useState(staged ?? null);
  const [busy, setBusy] = useState(false);
  const [imageState, setImageState] = useState<ContentImagesState | null>(null);
  const [imageLoadError, setImageLoadError] = useState(false);
  const [regenerateCover, setRegenerateCover] = useState(false);
  const [regenerateSlots, setRegenerateSlots] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/api/content/${itemId}`;
  const dirty = draftBody !== currentBody;
  const moved =
    proposal !== null &&
    (proposal.sourceBody !== currentBody ||
      proposal.sourceTitle !== currentTitle ||
      (proposal.imagePlan !== null && proposal.imagePlan.sourceCoverMediaId !== coverMediaId));
  const hasImageSelection = regenerateCover || regenerateSlots.length > 0;
  const hasInstruction = mode === "instruction" ? Boolean(instruction.trim()) : Boolean(noteId);
  const pendingImages =
    proposal?.imagePlan?.selections.some((selection) => !selection.generatedMediaId) ?? false;
  const uncertainImage = Boolean(proposal?.imagePlan?.inFlight);
  const suggestedParagraphCount =
    proposal?.proposal.split(/\n\s*\n/).filter((part) => part.trim()).length ?? 0;
  const imageMoveCount =
    imageState?.images.filter((slot) => slot.afterParagraph >= suggestedParagraphCount).length ?? 0;

  useEffect(() => setProposal(staged ?? null), [staged]);
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    void api<ContentImagesState>(`${base}/images`, { cache: "no-store" })
      .then((state) => {
        if (active) {
          setImageState(state);
          setImageLoadError(false);
        }
      })
      .catch(() => {
        if (active) {
          setImageState(null);
          setImageLoadError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [base, eligible]);

  async function loadNotes(next?: string) {
    try {
      const page = await apiPage<EditorialNoteDto>(
        `${base}/editorial-notes${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
      );
      setNotes((previous) => (next ? [...previous, ...page.rows] : page.rows));
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("notesError"), te));
    }
  }

  async function chooseMode(next: "instruction" | "note") {
    setMode(next);
    setError(null);
    if (next === "note") await loadNotes();
  }

  async function propose() {
    if (
      busy ||
      !eligible ||
      dirty ||
      (!hasInstruction && !hasImageSelection) ||
      (hasImageSelection && !imageState)
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const request = draftRevisionRequestSchema.parse({
        expectedTitle: currentTitle,
        expectedBody: currentBody,
        ...(mode === "instruction"
          ? instruction.trim()
            ? { instruction }
            : {}
          : noteId
            ? { noteId }
            : {}),
        ...(hasImageSelection
          ? {
              expectedImagesRevision: imageState?.revision,
              expectedCoverMediaId: coverMediaId,
              regenerateImages: { cover: regenerateCover, inlineSlotIds: regenerateSlots },
            }
          : {}),
      });
      const next = await api<DraftRevisionProposal>(`${base}/draft-revision`, {
        method: "POST",
        body: JSON.stringify(request),
      });
      setProposal(next);
      setRegenerateCover(false);
      setRegenerateSlots([]);
      setNotice(t("ready"));
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
      if (hasImageSelection) {
        try {
          const latest = await api<{ draftRevisionProposal: DraftRevisionProposal | null }>(base, {
            cache: "no-store",
          });
          if (
            latest.draftRevisionProposal?.imagePlan?.selections.some(
              (selection) => !selection.generatedMediaId,
            )
          ) {
            setProposal(latest.draftRevisionProposal);
            setNotice(
              latest.draftRevisionProposal.imagePlan?.inFlight
                ? t("uncertainImage")
                : t("partialReady"),
            );
          }
        } catch {
          /* The original generation error remains visible. */
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function resumeImages() {
    const plan = proposal?.imagePlan;
    if (!proposal || !plan || !pendingImages || busy) return;
    setBusy(true);
    setError(null);
    try {
      const request = draftRevisionRequestSchema.parse({
        expectedTitle: proposal.sourceTitle,
        expectedBody: proposal.sourceBody,
        ...(plan.textModelUsed ? { instruction: proposal.instruction } : {}),
        expectedCoverMediaId: plan.sourceCoverMediaId,
        expectedImagesRevision: plan.sourceImagesRevision,
        regenerateImages: {
          cover: plan.selections.some((selection) => selection.kind === "cover"),
          inlineSlotIds: plan.selections
            .filter((selection) => selection.kind === "inline")
            .map((selection) => selection.slotId),
        },
      });
      const next = await api<DraftRevisionProposal>(`${base}/draft-revision`, {
        method: "POST",
        body: JSON.stringify(request),
      });
      setProposal(next);
      setNotice(t("ready"));
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!proposal || busy || moved || dirty || pendingImages) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<{ title: string | null; body: string }>(
        `${base}/draft-revision/${proposal.id}/accept`,
        {
          method: "POST",
        },
      );
      setProposal(null);
      setNotice(t("accepted"));
      await onAccepted(updated.body, updated.title);
      void api<ContentImagesState>(`${base}/images`, { cache: "no-store" })
        .then(setImageState)
        .catch(() => setImageState(null));
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiVoid(`${base}/draft-revision/${proposal.id}`, { method: "DELETE" });
      setProposal(null);
      setNotice(t("discarded"));
    } catch (err) {
      if (err instanceof ApiError && err.code === "draft_revision_proposal_not_found") {
        setProposal(null);
        setNotice(t("discarded"));
      } else {
        setError(errorMessage(err, t("error"), te));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6" aria-label={t("title")}>
      <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
      <p className="mt-1 text-sm text-fg-secondary">{t("hint")}</p>
      <div className="mt-4 flex gap-2">
        <Button
          variant={mode === "instruction" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => void chooseMode("instruction")}
        >
          {t("writeInstruction")}
        </Button>
        <Button
          variant={mode === "note" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => void chooseMode("note")}
        >
          {t("useNote")}
        </Button>
      </div>
      {mode === "instruction" ? (
        <Textarea
          label={t("instruction")}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          rows={3}
          maxLength={2000}
          showCount
          className="mt-3"
        />
      ) : (
        <div className="mt-3">
          <label htmlFor="revision-note" className="text-sm text-fg-secondary">
            {t("chooseNote")}
          </label>
          <select
            id="revision-note"
            value={noteId}
            onChange={(event) => setNoteId(event.target.value)}
            className="mt-1 block w-full rounded-control border border-border-soft bg-surface px-3 py-2 text-sm text-fg"
          >
            <option value="">{t("chooseNote")}</option>
            {notes
              .filter((note) => note.current)
              .map((note) => (
                <option key={note.id} value={note.id}>
                  {note.note}
                </option>
              ))}
          </select>
          {notes.every((note) => !note.current) && (
            <p className="mt-2 text-sm text-fg-secondary">{t("noCurrentNotes")}</p>
          )}
          {cursor && (
            <Button variant="ghost" size="sm" onClick={() => void loadNotes(cursor)}>
              {t("loadMore")}
            </Button>
          )}
        </div>
      )}
      {eligible && (coverMediaId || (imageState?.images.length ?? 0) > 0 || imageLoadError) && (
        <fieldset className="mt-4 space-y-2 rounded-control border border-border-soft p-3">
          <legend className="px-1 text-sm font-medium text-fg">{t("imageSelection")}</legend>
          <p className="text-xs text-fg-secondary">{t("imageCostHint")}</p>
          {imageLoadError && (
            <p role="alert" className="text-sm text-danger">
              {t("imageLoadError")}
            </p>
          )}
          {coverMediaId && (
            <label className="flex items-center gap-3 rounded-control p-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={regenerateCover}
                onChange={(event) => setRegenerateCover(event.target.checked)}
                disabled={busy}
              />
              {/* biome-ignore lint/performance/noImgElement: same-origin authenticated media is served by the API */}
              <img
                src={`/api/media/${coverMediaId}/file`}
                alt=""
                className="h-12 w-12 rounded-control object-cover"
              />
              <span>{t("cover")}</span>
            </label>
          )}
          {imageState?.images.map((slot) => (
            <label
              key={slot.id}
              className="flex items-center gap-3 rounded-control p-2 text-sm text-fg"
            >
              <input
                type="checkbox"
                checked={regenerateSlots.includes(slot.id)}
                disabled={busy}
                onChange={(event) =>
                  setRegenerateSlots((current) =>
                    event.target.checked
                      ? [...current, slot.id]
                      : current.filter((id) => id !== slot.id),
                  )
                }
              />
              {/* biome-ignore lint/performance/noImgElement: same-origin authenticated media is served by the API */}
              <img
                src={`/api/media/${slot.mediaId}/file`}
                alt=""
                className="h-12 w-12 rounded-control object-cover"
              />
              <span>{t("inlineImage", { number: slot.afterParagraph + 1 })}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={
            busy ||
            !eligible ||
            dirty ||
            (!hasInstruction && !hasImageSelection) ||
            (hasImageSelection && !imageState) ||
            pendingImages
          }
          onClick={propose}
        >
          {busy ? t("working") : t("propose")}
        </Button>
        {!eligible && <span className="text-sm text-fg-secondary">{t("aiDraftOnly")}</span>}
        {dirty && <span className="text-sm text-fg-secondary">{t("saveFirst")}</span>}
      </div>
      {proposal && (
        <section
          className="mt-5 rounded-control border border-border-soft p-4"
          aria-label={t("proposalTitle")}
        >
          <h3 className="text-sm font-semibold text-fg">{t("proposalTitle")}</h3>
          <p className="mt-2 text-sm text-fg-secondary">
            {t("requested")}: {proposal.instruction}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium text-fg">{t("before")}</h4>
              <p className="mt-2 text-xs font-medium text-fg-tertiary">{t("titleLabel")}</p>
              <p className="mt-1 break-words text-sm font-medium text-fg-secondary">
                {proposal.sourceTitle || t("noTitle")}
              </p>
              <p className="mt-3 text-xs font-medium text-fg-tertiary">{t("bodyLabel")}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg-secondary">
                {proposal.sourceBody}
              </p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-fg">{t("after")}</h4>
              <p className="mt-2 text-xs font-medium text-fg-tertiary">{t("titleLabel")}</p>
              <p className="mt-1 break-words text-sm font-medium text-fg">
                {proposal.proposedTitle || t("noTitle")}
              </p>
              <p className="mt-3 text-xs font-medium text-fg-tertiary">{t("bodyLabel")}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">
                {proposal.proposal}
              </p>
            </div>
          </div>
          <p className="mt-3 text-sm text-fg-secondary">{proposal.reason}</p>
          {imageMoveCount > 0 && (
            <p className="mt-3 text-sm text-fg-secondary">{t("imagesMoveToLastParagraph")}</p>
          )}
          {proposal.imagePlan && proposal.imagePlan.selections.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-medium text-fg">{t("generatedImages")}</h4>
              <p className="mt-1 text-xs text-fg-secondary">{t("generatedImagesHint")}</p>
              <div className="mt-2 flex flex-wrap gap-3">
                {proposal.imagePlan.selections.map((selection) => (
                  <div
                    key={`${selection.kind}:${selection.slotId ?? "cover"}`}
                    className="rounded-control border border-border-soft p-2"
                  >
                    {selection.generatedMediaId ? (
                      // biome-ignore lint/performance/noImgElement: same-origin authenticated media is served by the API
                      <img
                        src={`/api/media/${selection.generatedMediaId}/file`}
                        alt={
                          selection.kind === "cover"
                            ? t("cover")
                            : t("inlineImage", { number: (selection.afterParagraph ?? 0) + 1 })
                        }
                        className="h-32 w-32 rounded-control object-cover"
                      />
                    ) : (
                      <div className="flex h-32 w-32 items-center justify-center rounded-control bg-surface text-xs text-fg-secondary">
                        {t("pendingImage")}
                      </div>
                    )}
                    <p className="mt-1 text-xs text-fg-secondary">
                      {selection.kind === "cover"
                        ? t("cover")
                        : t("inlineImage", { number: (selection.afterParagraph ?? 0) + 1 })}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {moved && <p className="mt-2 text-sm text-danger">{t("stale")}</p>}
          {uncertainImage ? (
            <p className="mt-2 text-sm text-danger">{t("uncertainImage")}</p>
          ) : pendingImages ? (
            <p className="mt-2 text-sm text-fg-secondary">{t("partialReady")}</p>
          ) : null}
          <div className="mt-3 flex gap-2">
            {pendingImages && !uncertainImage && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || moved || dirty || !eligible}
                onClick={resumeImages}
              >
                {busy ? t("working") : t("resumeImages")}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || moved || dirty || !eligible || pendingImages}
              onClick={accept}
            >
              {t("accept")}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={discard}>
              {t("discard")}
            </Button>
          </div>
        </section>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}

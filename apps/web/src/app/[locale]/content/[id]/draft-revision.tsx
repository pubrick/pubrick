"use client";

import {
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
  currentBody,
  draftBody,
  eligible,
  staged,
  onAccepted,
}: {
  itemId: string;
  currentBody: string;
  draftBody: string;
  eligible: boolean;
  staged: DraftRevisionProposal | null;
  onAccepted: (body: string) => Promise<void>;
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/api/content/${itemId}`;
  const dirty = draftBody !== currentBody;
  const moved = proposal !== null && proposal.sourceBody !== currentBody;

  useEffect(() => setProposal(staged ?? null), [staged]);

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
    if (busy || !eligible || dirty || (mode === "instruction" ? !instruction.trim() : !noteId))
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const request = draftRevisionRequestSchema.parse({
        expectedBody: currentBody,
        ...(mode === "instruction" ? { instruction } : { noteId }),
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
    if (!proposal || busy || moved || dirty) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<{ body: string }>(`${base}/draft-revision/${proposal.id}/accept`, {
        method: "POST",
      });
      setProposal(null);
      setNotice(t("accepted"));
      await onAccepted(updated.body);
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
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={
            busy || !eligible || dirty || (mode === "instruction" ? !instruction.trim() : !noteId)
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
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg-secondary">
                {proposal.sourceBody}
              </p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-fg">{t("after")}</h4>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">
                {proposal.proposal}
              </p>
            </div>
          </div>
          <p className="mt-3 text-sm text-fg-secondary">{proposal.reason}</p>
          {moved && <p className="mt-2 text-sm text-danger">{t("stale")}</p>}
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || moved || dirty || !eligible}
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

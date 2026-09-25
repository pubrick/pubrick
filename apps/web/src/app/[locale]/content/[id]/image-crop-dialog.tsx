"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";

/** Crop coordinates are measured against the original authenticated image. */
export function ImageCropDialog({
  mediaId,
  busy,
  onCancel,
  onSave,
}: {
  mediaId: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (area: Area) => void;
}) {
  const t = useTranslations("InlineImages");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [sourceAspect, setSourceAspect] = useState(4 / 3);
  const [aspectChoice, setAspectChoice] = useState("original");
  const [area, setArea] = useState<Area | null>(null);
  const onCropComplete = useCallback((_: Area, pixels: Area) => setArea(pixels), []);
  const aspect = aspectChoice === "original" ? sourceAspect : Number(aspectChoice);
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={t("cropTitle")}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {t("cropCancel")}
          </Button>
          <Button
            disabled={busy || !area}
            onClick={() => {
              if (area) onSave(area);
            }}
          >
            {busy ? t("cropping") : t("cropSave")}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-secondary">{t("cropHint")}</p>
      <div className="relative h-64 overflow-hidden rounded-control bg-bg-sunken sm:h-80">
        <Cropper
          image={`/api/media/${mediaId}/file`}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
          onMediaLoaded={(size) => setSourceAspect(size.naturalWidth / size.naturalHeight)}
          roundCropAreaPixels
          restrictPosition
        />
      </div>
      <Select
        label={t("cropAspect")}
        value={aspectChoice}
        onChange={(event) => {
          setArea(null);
          setAspectChoice(event.target.value);
        }}
      >
        <option value="original">{t("cropAspectOriginal")}</option>
        <option value="1">{t("cropAspectSquare")}</option>
        <option value="1.3333333333">4:3</option>
        <option value="1.7777777778">16:9</option>
        <option value="0.75">3:4</option>
      </Select>
      <label className="mt-4 block text-sm text-fg-secondary" htmlFor="article-image-crop-zoom">
        {t("cropZoom")}
      </label>
      <input
        id="article-image-crop-zoom"
        type="range"
        min="1"
        max="3"
        step="0.01"
        value={zoom}
        onChange={(event) => setZoom(Number(event.target.value))}
        disabled={busy}
        className="mt-2 w-full accent-accent"
      />
    </Modal>
  );
}

"use client";

import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { mediaReadHeaders } from "@/lib/media-room-access";

/** Header-authenticated images without putting room credentials in their URL. */
export function MediaImage({ src, fallback = null, ...props }: Omit<ComponentProps<"img">, "src" | "onError"> & {
  src: string;
  fallback?: ReactNode;
}) {
  const [image, setImage] = useState<{ src: string; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    async function load() {
      try {
        if (!/^\/api\/media\/(?:artwork|posters)\/[^/?#]+$/.test(src)) throw new Error("Invalid media image path");
        const response = await fetch(src, {
          headers: await mediaReadHeaders(),
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setFailed(null);
        setImage({ src, url });
      } catch {
        if (!controller.signal.aborted) setFailed(src);
      }
    }
    void load();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);
  if (failed === src) return fallback;
  return image?.src === src ? <img {...props} src={image.url} onError={() => setFailed(src)} /> : null;
}

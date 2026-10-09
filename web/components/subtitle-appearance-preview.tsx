"use client";

import React, { useEffect, useRef } from "react";
import { paintSubtitleLines, subtitleMarginPx } from "@/lib/mkv/subtitle-paint";
import type { SubtitleAppearance } from "@/lib/player-preferences";

const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 720;
/** 两行中英示例：预览不依赖当前媒体是否正在显示字幕（追加裁决）。 */
const PREVIEW_LINES = ["这是一行中文字幕示例", "English subtitle sample"];

/** 设置窗内的实时外观预览：与 MKV 画布/原生覆盖层共用同一绘制器，所见即所得。 */
export function SubtitleAppearancePreview({ appearance }: { appearance: SubtitleAppearance }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const backdrop = context.createLinearGradient(0, 0, 0, canvas.height);
      backdrop.addColorStop(0, "#242424");
      backdrop.addColorStop(1, "#141414");
      context.fillStyle = backdrop;
      context.fillRect(0, 0, canvas.width, canvas.height);
      paintSubtitleLines(context, PREVIEW_LINES, appearance, canvas.width, canvas.height,
        subtitleMarginPx(canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight));
    };
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [appearance]);

  return (
    <canvas
      ref={canvasRef}
      width={PREVIEW_WIDTH}
      height={PREVIEW_HEIGHT}
      aria-label="字幕外观预览"
      data-testid="subtitle-appearance-preview"
      className="block aspect-video w-full rounded-md border border-border"
    />
  );
}

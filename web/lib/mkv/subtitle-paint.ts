import type { SubtitleAppearance, SubtitleColor } from "../player-preferences";

/** 普通文本字幕调色板（画布与设置预览共用）。 */
export const SUBTITLE_COLORS: Record<SubtitleColor, string> = {
  white: "#fff",
  yellow: "#ffd400",
  cyan: "#00e5ff",
  green: "#7cfc00",
};

/** 字号（画布像素）：以画面高度的 1/24 为 100%，下限 20px。 */
export function cueFontPx(height: number, fontScale: number): number {
  return Math.round(Math.max(20, height / 24) * (Math.min(300, Math.max(50, fontScale)) / 100));
}

/** 底栏浮层约占画面下缘 112 CSS px；按显示缩放换算安全区基线，字幕不被控制层遮挡。 */
export function subtitleMarginPx(width: number, height: number, clientWidth: number, clientHeight: number): number {
  const scale = Math.min((clientWidth || width) / width, (clientHeight || height) / height) || 1;
  return Math.max(height / 9, Math.min(height * 0.3, 112 / scale));
}

/**
 * 把若干行字幕画到画布底部安全区（MKV 画布、原生覆盖层、设置预览共用同一实现）。
 * 档位：字重 normal/bold；描边 none/thin/thick；阴影 none/soft/strong；背景透明度 0–100%；上移 0/5–30%。
 */
export function paintSubtitleLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  style: SubtitleAppearance,
  width: number,
  height: number,
  marginPx: number,
): void {
  if (lines.length === 0) return;
  const fontPx = cueFontPx(height, style.fontScale);
  const fillColor = SUBTITLE_COLORS[style.color] ?? SUBTITLE_COLORS.white;
  context.save();
  context.font = `${style.fontWeight === "bold" ? "bold " : ""}${fontPx}px sans-serif`;
  context.textAlign = "center";
  const raise = style.bottomRaisePercent > 0
    ? (Math.min(30, Math.max(5, style.bottomRaisePercent)) / 100) * height : 0;
  // 自动安全区为基准；手动上移后再夹一层防裁切边界（渲染器约束范围）。
  const baseline = Math.max(fontPx * 2, height - marginPx - raise);
  const lineHeight = height / 20;
  const outlineWidth = style.outline === "none" ? 0
    : style.outline === "thick" ? Math.max(6, height / 100) : Math.max(3, height / 200);
  const shadowBlur = style.shadow === "strong" ? fontPx * 0.9 : style.shadow === "soft" ? fontPx * 0.45 : 0;
  const shadowOffsetY = style.shadow === "strong" ? fontPx * 0.16 : style.shadow === "soft" ? fontPx * 0.08 : 0;
  const backgroundAlpha = Math.max(0, Math.min(100, style.backgroundOpacity)) / 100;
  lines.forEach((line, index) => {
    const y = baseline - (lines.length - index - 1) * lineHeight;
    if (backgroundAlpha > 0) {
      context.save();
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;
      const textWidth = Math.min(context.measureText(line).width, width * 0.9);
      context.fillStyle = `rgba(0,0,0,${backgroundAlpha})`;
      context.fillRect(width / 2 - textWidth / 2 - fontPx * 0.3, y - fontPx, textWidth + fontPx * 0.6, fontPx * 1.3);
      context.restore();
    }
    context.shadowColor = "rgba(0,0,0,0.85)";
    context.shadowBlur = shadowBlur;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = shadowOffsetY;
    if (outlineWidth > 0) {
      context.lineWidth = outlineWidth;
      context.strokeStyle = "#000";
      context.strokeText(line, width / 2, y, width * 0.9);
    }
    context.fillStyle = fillColor;
    context.fillText(line, width / 2, y, width * 0.9);
  });
  context.restore();
}

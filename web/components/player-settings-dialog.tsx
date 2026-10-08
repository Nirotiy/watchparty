"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  LANGUAGE_OPTIONS, SUBTITLE_BOTTOM_RAISE_MAX, SUBTITLE_BOTTOM_RAISE_MIN, SUBTITLE_FONT_MAX, SUBTITLE_FONT_MIN,
  type PlayerPreferences, type SubtitleAppearance, type SubtitleSourcePreference,
} from "@/lib/player-preferences";

type SettingsSection = "basic" | "appearance" | "offset" | "reset";

interface PlayerSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preferences: PlayerPreferences;
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onSubtitlesOffChange: (off: boolean) => void;
  onSourcePreferenceChange: (preference: SubtitleSourcePreference) => void;
  onLanguageListChange: (kind: "audio" | "subtitle", next: string[]) => void;
  updateAppearance: (patch: Partial<SubtitleAppearance>) => void;
  subtitleOffset: number;
  onOffsetDelta: (delta: number) => void;
  onOffsetZero: () => void;
  /** 语境说明（ASS 原样式 / YouTube 自身能力）；null＝当前设置适用。 */
  appearanceNotice: string | null;
  appearanceDisabled: boolean;
  onResetPreferences: () => void;
  onClearAllOffsets: () => void;
}

function ToggleSwitch({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
        checked ? "border-sky-500/40 bg-sky-500/30" : "border-border bg-secondary",
      )}
    >
      <span className={cn("absolute top-0.5 left-0.5 block size-3.5 rounded-full bg-white transition-transform", checked && "translate-x-4")} />
    </button>
  );
}

function languageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find((option) => option.value === code)?.label ?? code;
}

export function PlayerSettingsDialog(props: PlayerSettingsDialogProps) {
  const {
    open, onOpenChange, preferences, volume, muted, onVolumeChange, onToggleMute, onSubtitlesOffChange,
    onSourcePreferenceChange, onLanguageListChange, updateAppearance, subtitleOffset, onOffsetDelta, onOffsetZero,
    appearanceNotice, appearanceDisabled, onResetPreferences, onClearAllOffsets,
  } = props;
  const [section, setSection] = useState<SettingsSection>("basic");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const appearance = preferences.subtitleAppearance;

  const chip = (active: boolean) => cn(
    "h-7 rounded-md border px-2.5 text-xs transition-colors",
    active ? "border-sky-500/40 bg-sky-500/20 text-sky-400" : "border-border font-normal text-muted-foreground hover:bg-secondary hover:text-white",
    appearanceDisabled && "cursor-not-allowed opacity-50",
  );

  const languageRows = (kind: "audio" | "subtitle") => {
    const list = kind === "audio" ? preferences.audioLanguages : preferences.subtitleLanguages;
    const label = kind === "audio" ? "音轨语言" : "字幕语言";
    const setList = (next: string[]) => onLanguageListChange(kind, next);
    const move = (index: number, delta: number) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
      setList(next);
    };
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}（按顺序匹配）</span>
          <select
            aria-label={`添加${label}`}
            value=""
            onChange={(event) => { if (event.target.value) setList([...list, event.target.value]); }}
            className="h-6 rounded-md border border-border bg-secondary px-1.5 text-xs text-foreground outline-none focus:border-ring"
          >
            <option value="">＋ 添加语言…</option>
            {LANGUAGE_OPTIONS.filter((option) => !list.includes(option.value)).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        {list.length === 0 ? (
          <p className="text-xs text-muted-foreground">留空＝媒体默认</p>
        ) : (
          <div className="space-y-1">
            {list.map((code, index) => (
              <div key={code} className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1">
                <span className="min-w-0 truncate text-xs text-foreground/85">
                  {index + 1} · {languageLabel(code)} <span className="font-mono text-[10px] text-muted-foreground">{code}</span>
                </span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <Button variant="ghost" size="icon-sm" aria-label={`上移 ${code}`} disabled={index === 0}
                    className="size-6 text-muted-foreground hover:text-white" onClick={() => move(index, -1)}>
                    <MsIconSmall name="arrow_upward" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`下移 ${code}`} disabled={index === list.length - 1}
                    className="size-6 text-muted-foreground hover:text-white" onClick={() => move(index, 1)}>
                    <MsIconSmall name="arrow_downward" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`移除 ${code}`}
                    className="size-6 text-muted-foreground hover:text-white" onClick={() => setList(list.filter((item) => item !== code))}>
                    <MsIconSmall name="close" />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const navItems: Array<{ key: SettingsSection; label: string }> = [
    { key: "basic", label: "基础" },
    { key: "appearance", label: "字幕外观" },
    { key: "offset", label: "字幕偏移" },
    { key: "reset", label: "恢复" },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setConfirmingClear(false); }}>
      <DialogContent className="w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-[680px]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle className="text-[15px] font-medium">本机设置</DialogTitle>
          <span className="text-[10px] text-muted-foreground">自动保存本机 · 不发送房间命令</span>
        </div>
        <div className="grid sm:grid-cols-[150px_1fr]">
          <nav className="flex gap-1 border-b border-border p-2 sm:flex-col sm:border-r sm:border-b-0" aria-label="设置分组">
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-left text-xs transition-colors sm:flex-none",
                  section === item.key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="max-h-[62vh] space-y-3 overflow-y-auto p-4">
            {section === "basic" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">默认音量</span>
                  <span className="flex flex-1 items-center justify-end gap-2">
                    <Slider value={[volume]} min={0} max={100} step={5} aria-label="默认音量"
                      className="w-40" onValueChange={(values) => onVolumeChange(values[0] ?? volume)} />
                    <span className="w-8 text-right font-mono text-xs">{volume}</span>
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">静音</span>
                  <ToggleSwitch checked={muted} onToggle={onToggleMute} label="静音" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">关闭字幕</span>
                  <ToggleSwitch checked={preferences.subtitlesOff} onToggle={() => onSubtitlesOffChange(!preferences.subtitlesOff)} label="关闭字幕" />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">字幕来源优先级</span>
                  <span className="flex gap-1">
                    <button type="button" aria-pressed={preferences.subtitleSourcePreference === "external"}
                      onClick={() => onSourcePreferenceChange("external")}
                      className={chip(preferences.subtitleSourcePreference === "external")}>外挂优先</button>
                    <button type="button" aria-pressed={preferences.subtitleSourcePreference === "embedded"}
                      onClick={() => onSourcePreferenceChange("embedded")}
                      className={chip(preferences.subtitleSourcePreference === "embedded")}>内嵌优先</button>
                  </span>
                </div>
                {languageRows("audio")}
                {languageRows("subtitle")}
                <p className="text-[10px] text-muted-foreground">
                  重复匹配规则：按列表顺序逐项，先精确标签再主语言回退；同语言多个字幕候选按来源优先级；列表为空＝媒体默认。改动下次载入媒体生效。
                </p>
              </div>
            )}

            {section === "appearance" && (
              <div className="space-y-3">
                {appearanceNotice && <p className="text-xs text-warn">{appearanceNotice}</p>}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">字号</span>
                  <span className="flex flex-1 items-center justify-end gap-2">
                    <Slider value={[appearance.fontScale]} min={SUBTITLE_FONT_MIN} max={SUBTITLE_FONT_MAX} step={25}
                      aria-label="字幕字号" disabled={appearanceDisabled} className="w-40"
                      onValueChange={(values) => updateAppearance({ fontScale: values[0] ?? appearance.fontScale })} />
                    <span className="w-12 text-right font-mono text-xs">{appearance.fontScale}%</span>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">颜色</span>
                  <span className="flex gap-1">
                    <button type="button" disabled={appearanceDisabled} onClick={() => updateAppearance({ color: "white" })} className={chip(appearance.color === "white")}>白字</button>
                    <button type="button" disabled={appearanceDisabled} onClick={() => updateAppearance({ color: "yellow" })} className={chip(appearance.color === "yellow")}>黄字</button>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">描边</span>
                  <span className="flex gap-1">
                    <button type="button" disabled={appearanceDisabled} onClick={() => updateAppearance({ outline: true })} className={chip(appearance.outline)}>黑描边</button>
                    <button type="button" disabled={appearanceDisabled} onClick={() => updateAppearance({ outline: false })} className={chip(!appearance.outline)}>无描边</button>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">背景</span>
                  <span className="flex gap-1">
                    <button type="button" disabled={appearanceDisabled} onClick={() => updateAppearance({ background: "none" })} className={chip(appearance.background === "none")}>无背景</button>
                    <button type="button" disabled={appearanceDisabled} onClick={() => updateAppearance({ background: "black" })} className={chip(appearance.background === "black")}>黑底</button>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">底部位置</span>
                  <span className="flex items-center gap-1">
                    <button type="button" disabled={appearanceDisabled} aria-pressed={appearance.bottomRaisePercent === 0}
                      onClick={() => updateAppearance({ bottomRaisePercent: 0 })} className={chip(appearance.bottomRaisePercent === 0)}>自动安全区</button>
                    <button type="button" disabled={appearanceDisabled} aria-pressed={appearance.bottomRaisePercent > 0}
                      onClick={() => updateAppearance({ bottomRaisePercent: appearance.bottomRaisePercent > 0 ? appearance.bottomRaisePercent : 10 })}
                      className={chip(appearance.bottomRaisePercent > 0)}>手动</button>
                  </span>
                </div>
                {appearance.bottomRaisePercent > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">上移</span>
                    <span className="flex flex-1 items-center justify-end gap-2">
                      <Slider value={[appearance.bottomRaisePercent]} min={SUBTITLE_BOTTOM_RAISE_MIN} max={SUBTITLE_BOTTOM_RAISE_MAX} step={5}
                        aria-label="字幕上移百分比" disabled={appearanceDisabled} className="w-40"
                        onValueChange={(values) => updateAppearance({ bottomRaisePercent: values[0] ?? appearance.bottomRaisePercent })} />
                      <span className="w-12 text-right font-mono text-xs">{appearance.bottomRaisePercent}%</span>
                    </span>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">只作用于普通文本字幕（VTT/SRT）；ASS 使用原样式与附件字体。</p>
              </div>
            )}

            {section === "offset" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">字幕偏移（当前媒体）</span>
                  <span className="font-mono text-xs text-sky-400">{subtitleOffset >= 0 ? `+${subtitleOffset.toFixed(1)}` : subtitleOffset.toFixed(1)}s</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={() => onOffsetDelta(-0.1)}>-0.1s</Button>
                  <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={onOffsetZero}>归零</Button>
                  <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={() => onOffsetDelta(0.1)}>+0.1s</Button>
                </div>
                <p className="text-[10px] text-muted-foreground">范围 -30s 到 +30s，步进 0.1s；正值延后字幕。按媒体单独保存。</p>
              </div>
            )}

            {section === "reset" && (
              <div className="space-y-2">
                <Button variant="secondary" size="sm" className="h-7 w-full justify-start px-2 text-xs font-normal" onClick={onResetPreferences}>
                  <MsIconSmall name="restart_alt" />
                  重置播放器偏好（音量 / 静音 / 语言 / 来源 / 字幕外观）
                </Button>
                {confirmingClear ? (
                  <div className="flex items-center gap-1.5">
                    <Button variant="destructive" size="sm" className="h-7 flex-1 text-xs"
                      onClick={() => { onClearAllOffsets(); setConfirmingClear(false); }}>确认清除全部偏移</Button>
                    <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={() => setConfirmingClear(false)}>取消</Button>
                  </div>
                ) : (
                  <Button variant="secondary" size="sm" className="h-7 w-full justify-start px-2 text-xs font-normal" onClick={() => setConfirmingClear(true)}>
                    <MsIconSmall name="delete_sweep" />
                    清除全部媒体偏移…
                  </Button>
                )}
                <p className="text-[10px] text-muted-foreground">只影响本机播放偏好；不动房间凭据、最近房间与继续观看记录。</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 设置窗内的小号 material 图标（与播放器其余图标同一字体）。 */
function MsIconSmall({ name }: { name: string }) {
  return <span className="material-symbols-outlined select-none text-[14px] leading-none" aria-hidden="true">{name}</span>;
}

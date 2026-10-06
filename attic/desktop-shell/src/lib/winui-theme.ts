import type { Theme } from "@fluentui/react-theme"

/**
 * Fluent v9 reads its palette from this object, so every token we care about is
 * pointed at the WinUI 3 brush set in index.css instead of Fluent 2's own values.
 * Where the two specs disagree (radius, accent, neutrals) WinUI 3 wins.
 */
export function winuiFluentTheme(base: Theme): Theme {
  return {
    ...base,
    // Shape: ControlCornerRadius 4 / OverlayCornerRadius 8.
    borderRadiusNone: "0px",
    borderRadiusSmall: "4px",
    borderRadiusMedium: "4px",
    borderRadiusLarge: "8px",
    borderRadiusXLarge: "8px",
    // Type: Segoe UI Variable is missing from @fluentui/tokens, so set the ramp.
    fontFamilyBase: 'var(--font-sans)',
    fontFamilyMonospace: 'var(--font-mono)',
    fontSizeBase300: "12px",
    fontSizeBase400: "14px",
    fontSizeBase500: "16px",
    fontSizeBase600: "20px",
    fontSizeHero700: "28px",
    lineHeightBase300: "16px",
    lineHeightBase400: "20px",
    lineHeightBase500: "22px",
    lineHeightBase600: "22px",
    fontWeightRegular: 400,
    fontWeightSemibold: 600,
    fontWeightBold: 700,
    // Accent
    colorBrandBackground: "var(--accent)",
    colorBrandBackgroundHover: "var(--accent-hover)",
    colorBrandBackgroundPressed: "var(--accent-press)",
    colorBrandBackground2: "var(--fill-selected)",
    colorBrandForeground1: "var(--accent)",
    colorBrandForeground2: "var(--accent-hover)",
    colorBrandForegroundOnLight: "var(--accent)",
    colorNeutralForegroundOnBrand: "var(--fg-on-accent)",
    colorCompoundBrandStroke: "var(--accent)",
    colorCompoundBrandStrokeHover: "var(--accent-hover)",
    colorCompoundBrandStrokePressed: "var(--accent-press)",
    colorCompoundBrandForeground1: "var(--accent)",
    colorCompoundBrandForeground1Hover: "var(--accent-hover)",
    colorCompoundBrandBackground: "var(--accent)",
    colorCompoundBrandBackgroundHover: "var(--accent-hover)",
    colorCompoundBrandBackgroundPressed: "var(--accent-press)",
    // Neutrals
    colorNeutralForeground1: "var(--text-primary)",
    colorNeutralForeground2: "var(--text-secondary)",
    colorNeutralForeground2Hover: "var(--text-primary)",
    colorNeutralForeground3: "var(--text-tertiary)",
    colorNeutralForeground3Hover: "var(--text-primary)",
    colorNeutralForegroundDisabled: "var(--text-disabled)",
    colorNeutralBackground1: "var(--base)",
    colorNeutralBackground1Hover: "var(--fill-subtle-hover)",
    colorNeutralBackground1Pressed: "var(--fill-subtle-press)",
    colorNeutralBackground2: "var(--base-secondary)",
    colorNeutralBackground3: "var(--base-tertiary)",
    colorNeutralBackground4: "var(--fill-control)",
    colorNeutralBackground5: "var(--fill-card)",
    colorNeutralBackground6: "var(--fill-selected)",
    colorSubtleBackground: "transparent",
    colorSubtleBackgroundHover: "var(--fill-subtle-hover)",
    colorSubtleBackgroundPressed: "var(--fill-subtle-press)",
    colorSubtleBackgroundSelected: "var(--fill-selected)",
    colorTransparentBackground: "transparent",
    // Strokes / focus
    colorNeutralStroke1: "var(--stroke-control)",
    colorNeutralStroke1Hover: "var(--stroke-strong)",
    colorNeutralStroke1Pressed: "var(--stroke-strong)",
    colorNeutralStroke2: "var(--stroke-divider)",
    colorNeutralStrokeAccessible: "var(--text-secondary)",
    colorStrokeFocus1: "var(--focus-inner)",
    colorStrokeFocus2: "var(--focus-outer)",
    // Status
    colorPaletteRedBackground2: "var(--critical-bg)",
    colorPaletteRedForeground1: "var(--critical)",
    // Elevation
    shadow2: "var(--f2-shadow2)",
    shadow4: "var(--f2-shadow2)",
    shadow8: "var(--f2-shadow8)",
    shadow16: "var(--f2-shadow16)",
    shadow28: "var(--f2-shadow16)",
    shadow64: "var(--f2-shadow16)",
  }
}

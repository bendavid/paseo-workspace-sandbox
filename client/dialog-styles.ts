import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";

// The app's text sizes (styles/theme.ts); plugins cannot import its tokens.
export const FONT = { sm: 12, base: 14, content: 15, title: 20 } as const;

/** The look of the plugin's confirmation dialogs. */
export function useDialogStyles(theme: PluginTheme) {
  return useMemo(() => {
    const button = {
      minHeight: 32,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 16,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    };
    return {
      text: { fontSize: FONT.base, color: theme.colors.foreground },
      muted: { fontSize: FONT.base, color: theme.colors.foregroundMuted },
      error: { fontSize: FONT.base, color: theme.colors.statusDanger },
      image: {
        fontSize: FONT.base,
        fontFamily: "monospace",
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        justifyContent: "flex-end" as const,
        gap: 8,
      },
      cancel: { ...button, borderWidth: 1, borderColor: theme.colors.border },
      cancelLabel: { fontSize: FONT.base, color: theme.colors.foreground },
      confirm: { ...button, flexShrink: 1, backgroundColor: theme.colors.accent },
      confirmLabel: {
        fontSize: FONT.base,
        fontWeight: "500" as const,
        color: theme.colors.accentForeground,
      },
    };
  }, [theme]);
}

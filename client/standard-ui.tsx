import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { onEscapeKey } from "./web";

// Values from the app's New workspace form (screens/new-workspace/form/field-trigger.tsx),
// combobox (components/ui/combobox.tsx), and theme tokens (styles/theme.ts). Plugins cannot
// import those components, so these mirror them.
export const ICON = { sm: 14, md: 16 } as const;
export const FONT = { sm: 12, base: 14, content: 15, title: 20 } as const;
const BADGE_HEIGHT = 28;
const FIELD_HEIGHT = 56;
const OPTION_MIN_HEIGHT = 36;
const POPOVER_OFFSET = 5;
const POPOVER_MAX_HEIGHT = 400;
const POPOVER_MIN_WIDTH = 250;
const SHEET_DISMISS_MS = 350;

type PressState = PressableStateCallbackType & { hovered?: boolean };

/** React Native Web draws a focus outline React Native's style types do not describe. */
export const WEB_NO_OUTLINE = { outlineStyle: "none" } as unknown as TextStyle;

function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Blends two hex colors; `amount` 0 is `from`, 1 is `to`. Non-hex colors return `from`. */
function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  const channel = (index: number) => Math.round(a[index]! + (b[index]! - a[index]!) * amount);
  return `#${[0, 1, 2].map((index) => channel(index).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Tones the app uses that the plugin theme does not carry, blended from the tokens it does:
 * foregroundExtraMuted (#a1a1aa on light) for chevrons and surface4 (#d4d4d8) for placeholders.
 */
export function extraMutedColor(theme: PluginTheme): string {
  return mix(theme.colors.foregroundMuted, theme.colors.border, 0.4);
}

export function placeholderColor(theme: PluginTheme): string {
  return mix(theme.colors.foregroundMuted, theme.colors.border, 0.85);
}

export function extraMuted(theme: PluginTheme): TextStyle {
  return { color: extraMutedColor(theme) };
}

export type Glyph =
  | { kind: "icon"; name: string }
  | { kind: "initial"; text: string }
  | { kind: "none" };

/** A 16px glyph: a muted Lucide icon, or a project's initial in a filled square. */
export function GlyphView({
  glyph,
  theme,
  size = ICON.sm,
}: {
  glyph: Glyph;
  theme: PluginTheme;
  size?: number;
}) {
  const styles = useMemo(
    () => ({
      box: {
        width: ICON.md,
        height: ICON.md,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        flexShrink: 0,
      },
      initial: {
        width: ICON.md,
        height: ICON.md,
        borderRadius: 4,
        backgroundColor: theme.colors.accent,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      initialText: {
        fontSize: 10,
        fontWeight: "600" as const,
        color: theme.colors.accentForeground,
      },
    }),
    [theme],
  );
  if (glyph.kind === "none") return null;
  if (glyph.kind === "initial") {
    return (
      <View style={styles.initial}>
        <Text style={styles.initialText}>{glyph.text.charAt(0).toUpperCase() || "?"}</Text>
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <Icon name={glyph.name} size={size} color={theme.colors.foregroundMuted} />
    </View>
  );
}

const CHEVRON_STYLE = { transform: [{ translateY: 1 }] };

export function Chevron({ theme }: { theme: PluginTheme }) {
  return (
    <View style={CHEVRON_STYLE}>
      <Icon name="ChevronDown" size={ICON.sm} color={extraMutedColor(theme)} />
    </View>
  );
}

export interface FieldTriggerProps {
  theme: PluginTheme;
  /** `field` on compact layouts, `badge` in the desktop row, as in New workspace. */
  variant: "badge" | "field";
  label: string;
  value: string;
  /** Extra-muted text after the value, such as a terminal profile's name. */
  detail?: string;
  glyph: Glyph;
  anchorRef?: RefObject<View | null>;
  /** Static fields show their value without a chevron or press target. */
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}

export function FieldTrigger({
  theme,
  variant,
  label,
  value,
  detail,
  glyph,
  anchorRef,
  onPress,
  disabled = false,
  testID,
}: FieldTriggerProps) {
  const styles = useMemo(
    () => ({
      badge: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        height: BADGE_HEIGHT,
        maxWidth: 240,
        overflow: "hidden" as const,
        paddingHorizontal: 8,
        borderRadius: 16,
        gap: 4,
      },
      field: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        height: FIELD_HEIGHT,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
        gap: 8,
      },
      highlighted: { backgroundColor: theme.colors.surface2 },
      badgePressed: { backgroundColor: theme.colors.surface0 },
      disabled: { opacity: 0.6 },
      value: {
        minWidth: 0,
        flexShrink: 1,
        fontSize: FONT.base,
        color: theme.colors.foregroundMuted,
      },
      fieldBody: { flex: 1, minWidth: 0, gap: 2 },
      fieldLabel: { fontSize: FONT.sm, color: theme.colors.foregroundMuted },
      fieldValueLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      fieldValue: {
        minWidth: 0,
        flexShrink: 1,
        fontSize: FONT.base,
        color: theme.colors.foreground,
      },
      detail: { color: extraMutedColor(theme) },
    }),
    [theme],
  );
  const pressStyle = useCallback(
    (state: PressState): ViewStyle[] => {
      const base = variant === "field" ? styles.field : styles.badge;
      if (disabled) return [base, styles.disabled];
      if (!onPress) return [base];
      if (state.pressed)
        return [base, variant === "field" ? styles.highlighted : styles.badgePressed];
      return state.hovered ? [base, styles.highlighted] : [base];
    },
    [disabled, onPress, styles, variant],
  );
  const valueLine = (
    <>
      <GlyphView glyph={glyph} theme={theme} />
      <Text style={variant === "field" ? styles.fieldValue : styles.value} numberOfLines={1}>
        {value}
        {detail ? <Text style={styles.detail}> {detail}</Text> : null}
      </Text>
    </>
  );
  const content =
    variant === "badge" ? (
      <>
        {valueLine}
        {onPress ? <Chevron theme={theme} /> : null}
      </>
    ) : (
      <>
        <View style={styles.fieldBody}>
          <Text style={styles.fieldLabel} numberOfLines={1}>
            {label}
          </Text>
          <View style={styles.fieldValueLine}>{valueLine}</View>
        </View>
        {onPress ? <Chevron theme={theme} /> : null}
      </>
    );
  return (
    <Pressable
      ref={anchorRef}
      collapsable={false}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      disabled={disabled || !onPress}
      style={pressStyle}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

export interface DropdownOption {
  id: string;
  label: string;
  description?: string;
  /** Shows the description in monospace, as for a terminal profile's command. */
  descriptionMono?: boolean;
  glyph: Glyph;
  selected?: boolean;
  disabled?: boolean;
  /** A group label row, such as "Terminal" in the launch menu; not selectable. */
  heading?: boolean;
}

interface OptionRowStyles {
  row: ViewStyle;
  rowHovered: ViewStyle;
  rowDisabled: ViewStyle;
  content: ViewStyle;
  label: TextStyle;
  description: TextStyle;
  descriptionMono: TextStyle;
  heading: TextStyle;
  trailing: ViewStyle;
}

function OptionRow({
  option,
  active,
  onChoose,
  theme,
  styles,
}: {
  option: DropdownOption;
  active: boolean;
  onChoose(id: string): void;
  theme: PluginTheme;
  styles: OptionRowStyles;
}) {
  const press = useCallback(() => onChoose(option.id), [onChoose, option.id]);
  const style = useCallback(
    (state: PressState): ViewStyle[] => [
      styles.row,
      ...(active || state.hovered || state.pressed ? [styles.rowHovered] : []),
      ...(option.disabled ? [styles.rowDisabled] : []),
    ],
    [active, option.disabled, styles],
  );
  const a11y = useMemo(() => ({ selected: option.selected === true }), [option.selected]);
  if (option.heading) {
    return <Text style={styles.heading}>{option.label}</Text>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={a11y}
      onPress={press}
      disabled={option.disabled}
      style={style}
    >
      <GlyphView glyph={option.glyph} theme={theme} />
      <View style={styles.content}>
        <Text style={styles.label} numberOfLines={1}>
          {option.label}
        </Text>
        {option.description ? (
          <Text
            style={option.descriptionMono ? styles.descriptionMono : styles.description}
            numberOfLines={1}
          >
            {option.description}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {option.selected ? (
          <Icon name="Check" size={ICON.md} color={theme.colors.foregroundMuted} />
        ) : null}
      </View>
    </Pressable>
  );
}

function optionKey(option: DropdownOption): string {
  return option.id;
}

export interface DropdownProps {
  theme: PluginTheme;
  compact: boolean;
  open: boolean;
  onClose(): void;
  /** The trigger the desktop popover hangs from. */
  anchorRef: RefObject<View | null>;
  /** The screen's root view, which hosts the desktop popover. */
  rootRef: RefObject<View | null>;
  /** Sheet title on compact layouts. */
  title: string;
  /** Rendered above the search row, such as the model picker's provider header. */
  header?: ReactNode;
  searchPlaceholder?: string;
  options: readonly DropdownOption[];
  onSelect(id: string): void;
  /** Rows below a divider, such as New profile. */
  footer?: readonly DropdownOption[];
  onFooterSelect?(id: string): void;
  emptyText: string;
  minWidth?: number;
  /** Which trigger edge the popover lines up with on wide layouts; New workspace's launch menu uses `end`. */
  align?: "start" | "end";
  /** Keep the popover open after a choice, for multi-level pickers. */
  keepOpen?: boolean;
}

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

function useDropdownPlacement(input: {
  open: boolean;
  compact: boolean;
  anchorRef: RefObject<View | null>;
  rootRef: RefObject<View | null>;
  minWidth: number;
  align: "start" | "end";
}): Placement | null {
  const { open, compact, anchorRef, rootRef, minWidth, align } = input;
  const [placement, setPlacement] = useState<Placement | null>(null);
  useEffect(() => {
    if (!open || compact) {
      setPlacement(null);
      return;
    }
    const anchor = anchorRef.current;
    const root = rootRef.current;
    if (!anchor || !root) return;
    root.measureInWindow((rootX, rootY, rootWidth, rootHeight) => {
      anchor.measureInWindow((x, y, width, height) => {
        const panelWidth = Math.max(width, minWidth);
        const preferred = align === "end" ? x - rootX + width - panelWidth : x - rootX;
        const left = Math.max(8, Math.min(preferred, rootWidth - panelWidth - 8));
        const top = y - rootY + height + POPOVER_OFFSET;
        setPlacement({
          left,
          top,
          width: panelWidth,
          maxHeight: Math.min(POPOVER_MAX_HEIGHT, Math.max(160, rootHeight - top - 8)),
        });
      });
    });
  }, [align, anchorRef, compact, minWidth, open, rootRef]);
  return placement;
}

/**
 * The app's combobox: an anchored popover on wide layouts and a bottom sheet on compact ones,
 * with a search row, check-marked options, and footer actions below a divider.
 */
export function Dropdown({
  theme,
  compact,
  open,
  onClose,
  anchorRef,
  rootRef,
  title,
  header,
  searchPlaceholder,
  options,
  onSelect,
  footer,
  onFooterSelect,
  emptyText,
  minWidth = POPOVER_MIN_WIDTH,
  align = "start",
  keepOpen = false,
}: DropdownProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const placement = useDropdownPlacement({ open, compact, anchorRef, rootRef, minWidth, align });
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle),
    );
  }, [options, query]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(-1);
    }
  }, [open]);
  useEffect(() => (open && !compact ? onEscapeKey(onClose) : undefined), [compact, onClose, open]);
  const choose = useCallback(
    (id: string) => {
      onSelect(id);
      if (!keepOpen) onClose();
    },
    [keepOpen, onClose, onSelect],
  );
  const chooseFooter = useCallback(
    (id: string) => {
      onClose();
      // A sheet that opens another sheet waits for its own dismissal, so the two never stack.
      if (compact) setTimeout(() => onFooterSelect?.(id), SHEET_DISMISS_MS);
      else onFooterSelect?.(id);
    },
    [compact, onClose, onFooterSelect],
  );
  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = event.nativeEvent;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        const step = key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => Math.max(0, Math.min(visible.length - 1, index + step)));
      } else if (key === "Enter") {
        const option = visible[activeIndex] ?? (visible.length === 1 ? visible[0] : undefined);
        if (option && !option.disabled) choose(option.id);
      }
    },
    [activeIndex, choose, visible],
  );
  const styles = useMemo(
    () => ({
      backdrop: {
        position: "absolute" as const,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 1000,
      },
      panel: {
        position: "absolute" as const,
        backgroundColor: theme.colors.surface0,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        shadowColor: "rgba(0, 0, 0, 0.12)",
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: 16,
        overflow: "hidden" as const,
        zIndex: 1001,
      },
      search: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingHorizontal: 12,
        gap: 8,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      searchInput: {
        flex: 1,
        paddingVertical: 12,
        color: theme.colors.foreground,
        fontSize: FONT.base,
        ...WEB_NO_OUTLINE,
      },
      list: { flexShrink: 1, minHeight: 0 },
      listContent: { paddingVertical: compact ? 4 : 4 },
      footer: { borderTopWidth: 1, borderTopColor: theme.colors.border },
      empty: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        color: theme.colors.foregroundMuted,
        fontSize: FONT.base,
      },
      sheetBody: { backgroundColor: theme.colors.surface0 },
      sheetContent: { padding: 0, gap: 0 },
      sheetList: { flex: 1, minHeight: 0 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        minHeight: OPTION_MIN_HEIGHT,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
      },
      rowHovered: { backgroundColor: theme.colors.surface1 },
      rowDisabled: { opacity: 0.55 },
      content: {
        flex: 1,
        flexShrink: 1,
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        gap: 8,
      },
      label: { fontSize: FONT.base, color: theme.colors.foreground, flexShrink: 0 },
      description: { fontSize: FONT.sm, color: theme.colors.foregroundMuted, flexShrink: 1 },
      descriptionMono: {
        fontSize: FONT.sm,
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontFamily: "monospace",
      },
      heading: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
        fontSize: FONT.sm,
        color: theme.colors.foregroundMuted,
      },
      trailing: { width: 16, alignItems: "center" as const, justifyContent: "center" as const },
    }),
    [compact, theme],
  );
  const panelStyle = useMemo(
    () =>
      placement
        ? [
            styles.panel,
            {
              left: placement.left,
              top: placement.top,
              width: placement.width,
              maxHeight: placement.maxHeight,
            },
          ]
        : [styles.panel, { opacity: 0 }],
    [placement, styles.panel],
  );
  const renderOption = useCallback(
    ({ item, index }: { item: DropdownOption; index: number }) => (
      <OptionRow
        option={item}
        active={index === activeIndex}
        onChoose={choose}
        theme={theme}
        styles={styles}
      />
    ),
    [activeIndex, choose, styles, theme],
  );
  const empty = useMemo(
    () => <Text style={styles.empty}>{emptyText}</Text>,
    [emptyText, styles.empty],
  );
  const body = (
    <>
      {header}
      {searchPlaceholder ? (
        <View style={styles.search}>
          <Icon name="Search" size={ICON.md} color={theme.colors.foregroundMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            onKeyPress={onKeyPress}
            placeholder={searchPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            autoFocus={!compact}
            style={styles.searchInput}
          />
        </View>
      ) : null}
      <FlatList
        style={compact ? styles.sheetList : styles.list}
        contentContainerStyle={styles.listContent}
        data={visible}
        keyExtractor={optionKey}
        renderItem={renderOption}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
      />
      {footer?.length ? (
        <View style={styles.footer}>
          {footer.map((option) => (
            <OptionRow
              key={option.id}
              option={option}
              active={false}
              onChoose={chooseFooter}
              theme={theme}
              styles={styles}
            />
          ))}
        </View>
      ) : null}
    </>
  );
  const closeSheet = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );
  if (compact) {
    return (
      <Modal title={title} open={open} onOpenChange={closeSheet}>
        <Modal.Content
          scrollable={false}
          style={styles.sheetBody}
          contentContainerStyle={styles.sheetContent}
        >
          {body}
        </Modal.Content>
      </Modal>
    );
  }
  if (!open) return null;
  return (
    <>
      <Pressable accessibilityLabel={`Close ${title}`} style={styles.backdrop} onPress={onClose} />
      <View style={panelStyle}>{body}</View>
    </>
  );
}

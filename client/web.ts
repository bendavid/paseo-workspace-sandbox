import { Platform } from "react-native";

// Plugins have no DOM types; declare only what this module uses.
interface KeyEventLike {
  key: string;
  preventDefault(): void;
}
interface KeyTarget {
  addEventListener(
    type: "keydown",
    listener: (event: KeyEventLike) => void,
    capture?: boolean,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyEventLike) => void,
    capture?: boolean,
  ): void;
}
declare const document: KeyTarget | undefined;

/** Calls `handler` on Escape while a popover is open, as the app's comboboxes do. Web only. */
export function onEscapeKey(handler: () => void): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const listener = (event: KeyEventLike) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    handler();
  };
  document.addEventListener("keydown", listener, true);
  return () => document?.removeEventListener("keydown", listener, true);
}

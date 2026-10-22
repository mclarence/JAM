import { create } from "zustand";

export type ThemePref = "light" | "dark" | "system";

const KEY = "jam-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (media.matches ? "dark" : "light") : pref;
}

function apply(resolved: "light" | "dark") {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

const initialPref = (localStorage.getItem(KEY) as ThemePref | null) ?? "system";
apply(resolve(initialPref));

interface ThemeState {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref: (pref: ThemePref) => void;
  toggle: () => void;
}

// Kept in localStorage (synchronous) so the theme applies before first paint.
export const useThemeStore = create<ThemeState>((set, get) => ({
  pref: initialPref,
  resolved: resolve(initialPref),
  setPref: (pref) => {
    localStorage.setItem(KEY, pref);
    const resolved = resolve(pref);
    apply(resolved);
    set({ pref, resolved });
  },
  toggle: () => get().setPref(get().resolved === "dark" ? "light" : "dark"),
}));

media.addEventListener("change", () => {
  const { pref } = useThemeStore.getState();
  if (pref !== "system") return;
  const resolved = resolve(pref);
  apply(resolved);
  useThemeStore.setState({ resolved });
});

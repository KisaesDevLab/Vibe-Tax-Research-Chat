// Font-size preference shared across the chat sidebar and admin shell —
// mirrors the Vibe-MyBooks / Vibe-Trial-Balance pattern. The scale applies
// `font-size` on the document root via a CSS custom property, so any
// rule that reads `var(--app-font-scale)` (or the body inherits the root
// size) picks it up. Persists to localStorage and broadcasts cross-tab.
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'vibe.fontSize';
const STEPS = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type FontSize = (typeof STEPS)[number];
const PX: Record<FontSize, number> = { xs: 12, sm: 14, md: 16, lg: 18, xl: 20 };

function readStored(): FontSize {
  if (typeof localStorage === 'undefined') return 'md';
  const v = localStorage.getItem(STORAGE_KEY);
  return (STEPS as readonly string[]).includes(v ?? '') ? (v as FontSize) : 'md';
}

function apply(size: FontSize) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${PX[size]}px`;
  document.documentElement.dataset.fontSize = size;
}

// Apply the saved size as soon as the module is imported, so the selector
// itself doesn't need to mount before the page reflects the user's choice.
apply(readStored());

export function useFontSize(): {
  size: FontSize;
  setSize: (s: FontSize) => void;
  bump: (delta: 1 | -1) => void;
  steps: readonly FontSize[];
} {
  const [size, setSizeState] = useState<FontSize>(readStored);

  // Cross-tab sync — a change in another tab updates this one too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === STORAGE_KEY &&
        e.newValue &&
        (STEPS as readonly string[]).includes(e.newValue)
      ) {
        const next = e.newValue as FontSize;
        setSizeState(next);
        apply(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setSize = useCallback((s: FontSize) => {
    setSizeState(s);
    apply(s);
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, s);
  }, []);

  const bump = useCallback(
    (delta: 1 | -1) => {
      const idx = STEPS.indexOf(size);
      const next = STEPS[Math.max(0, Math.min(STEPS.length - 1, idx + delta))]!;
      setSize(next);
    },
    [size, setSize],
  );

  return { size, setSize, bump, steps: STEPS };
}

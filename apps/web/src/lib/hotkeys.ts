// TP-1 — `g`-prefix navigation chords: g r / g p / g c switch modules.
// Two-key sequence with a 1 s window, ignored while typing in any
// editable element so the chords never eat chat-composer input.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const CHORD_WINDOW_MS = 1000;

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useGoHotkeys(opts: { planningEnabled: boolean }): void {
  const navigate = useNavigate();
  const pendingG = useRef<number | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;

      const now = Date.now();
      if (pendingG.current !== null && now - pendingG.current <= CHORD_WINDOW_MS) {
        pendingG.current = null;
        if (e.key === 'r') {
          e.preventDefault();
          navigate('/research');
          return;
        }
        if (e.key === 'p' && opts.planningEnabled) {
          e.preventDefault();
          navigate('/planning');
          return;
        }
        if (e.key === 'c' && opts.planningEnabled) {
          e.preventDefault();
          navigate('/clients');
          return;
        }
      }
      pendingG.current = e.key === 'g' ? now : null;
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, opts.planningEnabled]);
}

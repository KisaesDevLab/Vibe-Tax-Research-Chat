import type { Config } from 'tailwindcss';

// Phase 1 — Tailwind config. Editorial palette per kickoff:
// warm paper, deep ink, oxblood (citations), moss (compliance), gold (footnotes).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f7f3ec',
        ink: '#1a1714',
        oxblood: '#7a2a1a',
        moss: '#2f4a30',
        gold: '#b48a3a',
      },
      fontFamily: {
        display: ['"Fraunces"', 'Georgia', 'serif'],
        body: ['"Source Serif 4"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;

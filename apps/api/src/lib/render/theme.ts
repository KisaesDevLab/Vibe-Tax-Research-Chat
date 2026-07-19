// TP-9 — deliverable theming. Firm branding comes from appliance
// settings (FIRM_NAME already exists for the chat system prompt); print
// CSS is shared by every template so advisor/client/deck read as one
// family.
import { getSetting } from '../settings-store.js';

export interface Branding {
  firmName: string;
  accent: string;
}

export async function loadBranding(): Promise<Branding> {
  // Optional appliance setting; falls back to a neutral product name.
  const firmName = await getSetting<string>('firm_name');
  return { firmName: firmName ?? 'Vibe Tax Planning', accent: '#7a2a1a' };
}

export const PRINT_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1714; font-size: 11pt; }
  .page { padding: 48pt 54pt; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 22pt; margin-bottom: 6pt; }
  h2 { font-size: 15pt; margin: 14pt 0 6pt; }
  h3 { font-size: 12pt; margin: 10pt 0 4pt; }
  p, li { line-height: 1.45; }
  ul, ol { padding-left: 18pt; margin: 4pt 0 8pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em;
       color: #666; border-bottom: 1px solid #999; padding: 4pt 6pt; }
  td { padding: 4pt 6pt; border-bottom: 0.5px solid #ddd; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums;
       font-family: 'Courier New', monospace; font-size: 10pt; }
  .accent { color: var(--accent); }
  .muted { color: #777; }
  .small { font-size: 9pt; }
  .savings { color: #2f4a30; font-weight: bold; }
  .cost { color: #7a2a1a; }
  .band { display: inline-block; border: 1px solid #999; border-radius: 3pt;
       padding: 1pt 5pt; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em; }
  .footer { position: fixed; bottom: 18pt; left: 54pt; right: 54pt; font-size: 8pt;
       color: #888; border-top: 0.5px solid #ddd; padding-top: 4pt; font-style: italic; }
  .cover { display: flex; flex-direction: column; justify-content: center; height: 88vh; }
  .qual { border-left: 3pt solid #2f4a30; padding-left: 10pt; margin: 6pt 0; }
`;

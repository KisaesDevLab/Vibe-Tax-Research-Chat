// Staff-facing slideshow WEB VIEW (live HTML in the browser, no
// artifact). The PDF artifacts all render through deliverable-pdf.ts
// (PDFKit); this string template only serves the in-browser present
// mode, so it needs no React and no Chromium.
import { PRINT_CSS } from './theme.js';
import type { RenderData } from './types.js';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function renderSlideshowHtml(d: RenderData): string {
  const cumulativeBase = d.baseline.reduce((a, y) => a + y.totalBurden, 0);
  const cumulativeScen = d.scenario.reduce((a, y) => a + y.totalBurden, 0);
  const rows = d.baseline
    .map((y, i) => {
      const scen = d.scenario[i]?.totalBurden ?? 0;
      const delta = scen - y.totalBurden;
      return `<tr><td>${y.year}</td><td class="num">${esc(money(y.totalBurden))}</td><td class="num">${esc(
        money(scen),
      )}</td><td class="num ${delta < 0 ? 'savings' : 'cost'}">${esc(money(delta))}</td></tr>`;
    })
    .join('');
  const cumDelta = cumulativeScen - cumulativeBase;

  const slides = d.strategies
    .map((strat) => {
      const title = d.revealStrategies ? strat.name : strat.client.teaser;
      const benefits = strat.client.benefits.map((b) => `<li>${esc(b)}</li>`).join('');
      const advisory = strat.modeled
        ? ''
        : `<div class="qual"><p><strong>Structural recommendation</strong> — savings not computed; typical impact band: <span class="band">${esc(
            strat.typicalSavingsBand,
          )}</span></p><p>${esc(strat.client.headline)}</p></div>`;
      return `<div class="page"><h2>${esc(title)}</h2><p>${esc(strat.client.headline)}</p><ul>${benefits}</ul>${advisory}</div>`;
    })
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PRINT_CSS}
.page { min-height: 92vh; border-bottom: 2px solid #ddd; page-break-after: auto; }</style></head>
<body style="--accent:${esc(d.branding.accent)}">
<div class="page cover"><h1>${esc(d.plan.title)}</h1><p class="muted">${esc(d.clientName)}</p></div>
<div class="page"><h2>Projection</h2>
<table><thead><tr><th>Year</th><th class="num">Current path</th><th class="num">With plan</th><th class="num">Annual difference</th></tr></thead>
<tbody>${rows}<tr><td><strong>Cumulative</strong></td><td class="num">${esc(money(cumulativeBase))}</td><td class="num">${esc(
    money(cumulativeScen),
  )}</td><td class="num ${cumDelta < 0 ? 'savings' : 'cost'}"><strong>${esc(money(cumDelta))}</strong></td></tr></tbody></table>
</div>
${slides}
</body></html>`;
}

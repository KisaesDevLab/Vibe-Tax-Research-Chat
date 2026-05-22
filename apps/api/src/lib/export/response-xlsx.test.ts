import { describe, it, expect } from 'vitest';
import { buildResponseXlsx } from './response-xlsx.js';

const baseMessage = {
  id: '11111111-2222-3333-4444-555555555555',
  created_at: new Date('2026-05-22T12:34:56Z'),
  model_id: 'claude-opus-4-7',
  cost_usd: 0.0123,
  authorities: [],
  compliance_check: null,
};

describe('buildResponseXlsx', () => {
  it('renders a structured workpaper from a workpaper_data sidecar', async () => {
    const content = `# 2024 §199A QBI Deduction

Some prose here.

\`\`\`json
{
  "skill": "excel-workpaper-builder",
  "workpaper_data": {
    "sheet_name": "F-3 QBI Calc",
    "title": "2024 §199A QBI Deduction — Maria Garcia Properties LLC",
    "index": "F-3",
    "headers": ["Index", "Item", "Amount", "Tickmark"],
    "rows": [
      { "index": "F-3.1", "label": "QBI", "amount": 82500, "tickmark": "α" },
      { "index": "F-3.2", "label": "Tentative deduction (20%)",
        "formula": "=C2*0.20", "tickmark": "R" },
      { "index": "F-3.3", "label": "Net deduction",
        "formula": "=MIN(C2,C3)", "tickmark": "CF, R",
        "bold": true, "top_border": true }
    ],
    "tickmark_legend": [
      { "symbol": "α", "meaning": "Agreed to source" },
      { "symbol": "R", "meaning": "Recalculated" },
      { "symbol": "CF", "meaning": "Cross-foots" }
    ],
    "sources": ["GL.2024-12-31.csv exported 2025-01-08"],
    "notes": ["Below MFJ threshold — no W-2 / UBIA limit applies."]
  }
}
\`\`\`
`;

    const buf = await buildResponseXlsx({ ...baseMessage, content });
    // .xlsx is a zip — must start with the PK\x03\x04 local-file-header
    // magic. If exceljs returned the wrong content type or a malformed
    // buffer, this assertion catches it immediately.
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    expect(buf.byteLength).toBeGreaterThan(2000);
  });

  it('falls back to a prose dump when workpaper_data is absent', async () => {
    const content = `# Federal research answer

The taxpayer's QBI deduction is allowed.

Authorities support the conclusion.`;

    const buf = await buildResponseXlsx({ ...baseMessage, content });
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf.byteLength).toBeGreaterThan(2000);
  });

  it('extracts workpaper_data from a bare (unfenced) JSON object with nested braces', async () => {
    // The model occasionally drops the ```json fence. A naive non-greedy
    // regex truncates the capture at the first inner `}` and JSON.parse
    // fails. The balanced-brace extractor must walk past nested objects
    // and arrays inside workpaper_data.
    const content = `# Federal research conclusion

The taxpayer's QBI deduction is allowed.

{
  "skill": "excel-workpaper-builder",
  "workpaper_data": {
    "sheet_name": "QBI",
    "headers": ["Index", "Item", "Amount", "Tickmark"],
    "rows": [
      { "index": "1", "label": "QBI", "amount": 82500, "tickmark": "α" },
      { "index": "2", "label": "Total", "formula": "=SUM(C2:C2)",
        "tickmark": "CF", "bold": true, "top_border": true }
    ],
    "tickmark_legend": [
      { "symbol": "α", "meaning": "Agreed to source" }
    ]
  },
  "conclusion": "QBI applies."
}`;

    const buf = await buildResponseXlsx({ ...baseMessage, content });
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    // ~ 4kB+ if the structured renderer ran; the prose-fallback path
    // would be much smaller (no styled cells, no merged ranges).
    expect(buf.byteLength).toBeGreaterThan(3000);
  });

  it('handles a sheet_name exceeding the 31-char Excel cap', async () => {
    const longName = 'A'.repeat(60);
    const content = `\`\`\`json
{
  "workpaper_data": {
    "sheet_name": "${longName}",
    "headers": ["Index", "Item", "Amount", "Tickmark"],
    "rows": [
      { "index": "1", "label": "x", "amount": 100, "tickmark": "α" }
    ]
  }
}
\`\`\``;
    const buf = await buildResponseXlsx({ ...baseMessage, content });
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});

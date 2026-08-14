// Archive → PDF export tests. The point of TP-11's readability pass is that
// the frozen transcript reaches the page the way the archive VIEWER shows it
// — rendered markdown — so these assert that markdown syntax never survives
// into the drawn text while the content it marks up does.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import type { ResearchArchive } from '@vibe/db/schema';
import { buildArchivePdf } from './archive-pdf.js';

// PDFKit deflates its content streams; inflate them back so we can read the
// text operators. (markdown-pdf.test.ts builds its own doc with
// compress:false — here the builder owns the document, so we decompress.)
const CP1252_HIGH: Record<number, string> = {
  0x85: '…',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
};

function decodeWinAnsi(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  let out = '';
  for (const b of bytes) out += CP1252_HIGH[b] ?? String.fromCharCode(b);
  return out;
}

function inflateStreams(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    try {
      out += zlib.inflateSync(chunk).toString('latin1') + '\n';
    } catch {
      out += chunk.toString('latin1') + '\n'; // uncompressed (font programs etc.)
    }
  }
  return out;
}

function shownText(content: string): string {
  const runs: string[] = [];
  for (const block of content.match(/\[(?:[^[\]]|\\.)*\]\s*TJ/g) ?? []) {
    const hexes = block.match(/<([0-9A-Fa-f]*)>/g) ?? [];
    runs.push(hexes.map((h) => decodeWinAnsi(h.slice(1, -1))).join(''));
  }
  for (const single of content.match(/<([0-9A-Fa-f]*)>\s*Tj/g) ?? []) {
    runs.push(decodeWinAnsi(single.replace(/>\s*Tj$/, '').slice(1)));
  }
  return runs.join(' ');
}

function archive(overrides: Partial<ResearchArchive> = {}): ResearchArchive {
  const base = {
    id: '11111111-1111-1111-1111-111111111111',
    chat_id: '22222222-2222-2222-2222-222222222222',
    client_id: null,
    firm_archive: true,
    title: 'Augusta rule substantiation',
    topic_tags: ['280A(g)', 'documentation'],
    note: 'Filed for the 2026 planning cycle.',
    sha256: 'a'.repeat(64),
    archived_by: null,
    archived_at: new Date('2026-03-02T15:04:05Z'),
    status: 'active' as const,
    tombstone: null,
    plan_id: null,
    strategy_id: null,
    supersedes_id: null,
    snapshot_text: '',
    snapshot: {
      chat: {
        id: '22222222-2222-2222-2222-222222222222',
        title: 'Augusta rule substantiation',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
      messages: [
        {
          role: 'user',
          content: 'How many days can the **Augusta rule** cover?',
          created_at: '2026-03-01T10:00:00.000Z',
        },
        {
          role: 'assistant',
          content: [
            '## Short answer',
            '',
            'Up to **14 days** per year under §280A(g). See [the code](https://law.example/280A).',
            '',
            '### Rate support',
            '',
            '| Venue | Daily rate | Source |',
            '| --- | ---: | --- |',
            '| Hotel ballroom | $1,200 | Quote on file |',
            '| Conference center | $950 | Quote on file |',
            '',
            '- Document the business purpose',
            '- Keep three comparable quotes',
            '',
            '```',
            'days_used <= 14',
            '```',
            '',
            '```json authorities',
            '{"authorities":[{"cite":"IRC §280A(g)"}]}',
            '```',
          ].join('\n'),
          created_at: '2026-03-01T10:02:00.000Z',
          authorities: [
            {
              cite: 'IRC §280A(g)',
              type: 'statute',
              verified_this_turn: true,
              source: 'https://law.example/280A',
            },
          ],
        },
      ],
      consultations: [
        {
          tool_name: 'web_fetch',
          url: 'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf',
          query: null,
          domain: 'irs.gov',
          fetched_at: '2026-03-01T10:01:00.000Z',
          cited_in_authorities: true,
        },
      ],
      archived_from_version: 1,
    },
  } as unknown as ResearchArchive;
  return { ...base, ...overrides };
}

interface Rendered {
  /** Inflated content streams — the drawing operators. */
  content: string;
  /** The whole file — font dictionaries and link annotations live out here. */
  raw: string;
}

async function render(a: ResearchArchive, clientName: string | null = null): Promise<Rendered> {
  const pdf = await buildArchivePdf(a, clientName);
  return { content: inflateStreams(pdf), raw: pdf.toString('latin1') };
}

describe('buildArchivePdf', () => {
  it('renders the transcript as markdown, not as source', async () => {
    const { content, raw } = await render(archive());
    const text = shownText(content);

    expect(text).toContain('Short answer');
    expect(text).toContain('Rate support');
    expect(text).toContain('14 days');
    // Markdown syntax must not reach the page.
    expect(text).not.toContain('##');
    expect(text).not.toContain('**');
    expect(text).not.toMatch(/\]\(/);
    // Bold/italic runs are drawn with real fonts.
    expect(raw).toContain('Times-Bold');
  });

  it('draws GFM tables as tables and keeps the cell values', async () => {
    const text = shownText((await render(archive())).content);
    expect(text).toContain('Daily rate');
    expect(text).toContain('Hotel ballroom');
    expect(text).toContain('$1,200');
    // Pipe syntax is gone — the cells were drawn into columns.
    expect(text).not.toContain('| Venue |');
    expect(text).not.toContain('---');
  });

  it('renders bullets and fenced code', async () => {
    const { content, raw } = await render(archive());
    const text = shownText(content);
    expect(text).toContain('Document the business purpose');
    expect(text).toContain('•');
    expect(text).toContain('days_used <= 14');
    expect(raw).toContain('Courier');
  });

  it('strips the authorities sidecar JSON and renders the parsed record instead', async () => {
    const text = shownText((await render(archive())).content);
    expect(text).not.toContain('"authorities"');
    expect(text).toContain('AUTHORITIES CITED');
    expect(text).toContain('IRC §280A(g)');
    expect(text).toContain('[verified]');
  });

  it('keeps the header provenance block and stamps a footer on every page', async () => {
    const text = shownText((await render(archive(), 'Wren Holdings LLC')).content);
    expect(text).toContain('RESEARCH ARCHIVE');
    expect(text).toContain('Augusta rule substantiation');
    expect(text).toContain('Filed to: Wren Holdings LLC');
    expect(text).toContain(`SHA-256 ${'a'.repeat(64)}`);
    expect(text).toContain('Page 1 of');
    expect(text).toContain('USER');
    expect(text).toContain('ASSISTANT');
  });

  it('lists the consultation trail with its links', async () => {
    const { content, raw } = await render(archive());
    expect(shownText(content)).toContain('Primary-source consultations');
    expect(raw).toContain('rp-25-32.pdf');
  });

  it('surfaces superseded status and the tombstone', async () => {
    const text = shownText(
      (
        await render(
          archive({
            status: 'superseded',
            tombstone: {
              original_client: {
                id: '33333333-3333-3333-3333-333333333333',
                name: 'Old Client Co',
              },
              event: 'client-deleted',
              actor_user_id: null,
              at: '2026-02-01T00:00:00.000Z',
            },
          } as Partial<ResearchArchive>),
        )
      ).content,
    );
    expect(text).toContain('Status: superseded');
    expect(text).toContain('Old Client Co');
  });

  it('paginates a long transcript and restores the margin after each turn', async () => {
    const long = archive({
      snapshot: {
        ...archive().snapshot,
        messages: Array.from({ length: 40 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `### Turn ${i}\n\n${'Substantiation detail for the workpaper. '.repeat(20)}`,
          created_at: '2026-03-01T10:00:00.000Z',
        })),
      },
    } as Partial<ResearchArchive>);
    const pdf = await buildArchivePdf(long, null);
    const raw = pdf.toString('latin1');
    const pages = (raw.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    const text = shownText(inflateStreams(pdf));
    expect(text).toContain('Turn 39');
    expect(text).toContain(`Page ${pages} of ${pages}`);
  });

  it('handles an empty transcript without throwing', async () => {
    const empty = archive({
      snapshot: { ...archive().snapshot, messages: [], consultations: [] },
    } as Partial<ResearchArchive>);
    const pdf = await buildArchivePdf(empty, null);
    expect(pdf.length).toBeGreaterThan(500);
  });
});

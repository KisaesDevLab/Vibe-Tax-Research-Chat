// TP-11 — archive → PDF memo for the workpaper file. Deliberately plainer
// than response-pdf.ts: a header block (client, tags, sha256), then the
// transcript with role labels, then the consultation trail. Real text PDF
// via PDFKit so it's selectable and small.
import PDFDocument from 'pdfkit';
import type { ResearchArchive } from '@vibe/db/schema';

const MARGIN = 54;

// Minimal WinAnsi guard: swap the frequent offenders, strip emoji blocks.
function sanitize(s: string): string {
  return s
    .replace(/[→➡]/gu, ' -> ')
    .replace(/[←]/gu, ' <- ')
    .replace(/[≤]/gu, '<=')
    .replace(/[≥]/gu, '>=')
    .replace(/[≠]/gu, '!=')
    .replace(/[\u{2500}-\u{259F}]/gu, '-')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}\u{200B}\u{200C}]|\u{200D}/gu, '');
}

export function buildArchivePdf(
  archive: ResearchArchive,
  clientName: string | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: {
        Title: `Research archive — ${archive.title}`,
        Author: 'Vibe Tax Research',
        Subject: 'Archived research session memo',
        CreationDate: archive.archived_at,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Memo header ──
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1714').text('Research archive memo');
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(12).text(sanitize(archive.title));
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text(`Filed to: ${clientName ?? (archive.firm_archive ? 'Firm archive' : '—')}`);
    doc.text(`Archived: ${archive.archived_at.toLocaleString()}`);
    if (archive.topic_tags.length > 0) doc.text(`Tags: ${archive.topic_tags.join(', ')}`);
    if (archive.note) doc.text(`Note: ${sanitize(archive.note)}`);
    if (archive.status !== 'active') doc.text(`Status: ${archive.status}`);
    if (archive.tombstone) {
      doc.text(
        `Originally filed to ${archive.tombstone.original_client.name} — reassigned to the firm archive on client deletion (${archive.tombstone.at}).`,
      );
    }
    doc.font('Helvetica').fontSize(7).fillColor('#999999');
    doc.text(`Snapshot SHA-256: ${archive.sha256}`);
    doc.moveDown(0.5);
    hr(doc);

    // ── Transcript ──
    for (const m of archive.snapshot.messages) {
      doc.moveDown(0.5);
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#7a2a1a')
        .text(`${m.role.toUpperCase()} · ${new Date(m.created_at).toLocaleString()}`);
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(10).fillColor('#1a1714').text(sanitize(m.content));

      const authorities = Array.isArray(m.authorities) ? (m.authorities as unknown[]) : [];
      if (authorities.length > 0) {
        doc.moveDown(0.2);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#2f4a30').text('Authorities cited:');
        for (const a of authorities) {
          const auth = a as { cite?: string; source?: string; verified_this_turn?: boolean };
          if (!auth.cite) continue;
          const isUrl = typeof auth.source === 'string' && /^https?:\/\//.test(auth.source);
          doc
            .font('Helvetica')
            .fontSize(9)
            .fillColor('#2f4a30')
            .text(
              `• ${sanitize(auth.cite)}${auth.verified_this_turn ? ' [verified]' : ''}${
                auth.source ? ` — ${sanitize(auth.source)}` : ''
              }`,
              { link: isUrl ? auth.source : undefined },
            );
        }
      }
    }

    // ── Consultation trail ──
    const consultations = archive.snapshot.consultations as Array<{
      tool_name?: string;
      url?: string | null;
      query?: string | null;
      fetched_at?: string;
    }>;
    if (consultations.length > 0) {
      doc.moveDown(0.8);
      hr(doc);
      doc.moveDown(0.3);
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#1a1714')
        .text('Primary-source consultations');
      doc.moveDown(0.2);
      for (const c of consultations) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor('#666666')
          .text(
            sanitize(
              `${c.tool_name ?? 'tool'} · ${c.url ?? c.query ?? ''} · ${c.fetched_at ?? ''}`,
            ),
          );
      }
    }

    doc.moveDown(1);
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor('#888888')
      .text(
        'Vibe Tax Research · Immutable archived session; content frozen at archival. AI-generated research — verify citations before reliance.',
      );

    doc.end();
  });
}

function hr(doc: PDFKit.PDFDocument): void {
  doc
    .strokeColor('#dddddd')
    .lineWidth(0.5)
    .moveTo(MARGIN, doc.y)
    .lineTo(doc.page.width - MARGIN, doc.y)
    .stroke();
}

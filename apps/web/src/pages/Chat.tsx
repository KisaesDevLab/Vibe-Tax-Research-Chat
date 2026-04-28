// Phase 14-20 — chat page. Composes sidebar + message list + composer + panels.
import { useState, type FormEvent, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChatSidebar } from '../components/ChatSidebar';
import { Markdown } from '../components/Markdown';
import { CostLedger } from '../components/CostLedger';
import { AuthoritiesPanel } from '../components/panels/AuthoritiesPanel';
import { CompliancePanel } from '../components/panels/CompliancePanel';
import { SkillsPanel } from '../components/panels/SkillsPanel';
import { useChatStream, type StreamingMessage } from '../hooks/useChatStream';
import { api } from '../lib/api';
import type { ChatDTO, MessageDTO } from '@vibe/shared';

// The model emits structured authorities + compliance payloads at the end
// of every research turn so the API can persist them and the panels below
// the prose can render them as formatted document blocks (not JSON walls).
// We strip these payloads from the prose before handing it to Markdown.
//
// We have to handle four shapes the model produces in practice:
//   1. ```json authorities ... ```            (tagged-fence, the spec form)
//   2. ```authorities ... ```                 (no `json` keyword)
//   3. ```json\n{ "authorities": [...] }\n``` (generic JSON fence)
//   4. raw `{ "authorities": [...] }` with no fence at all
// All four occur in the wild because the system prompt asks for fenced
// blocks but the model doesn't always comply. We also have to handle the
// streaming case where the closing fence hasn't arrived yet — treat an
// unclosed authorities/compliance block as already strippable so users
// don't see a half-rendered JSON wall during streaming.

const KEYWORD_RE = /authorities|compliance/i;

function stripSidecars(text: string): string {
  let out = text;

  // Pass 1: fenced blocks. Match a fence that either has authorities/
  // compliance in its info string, OR has an authorities/compliance key
  // in the first ~200 chars of its body. The closing fence is optional
  // (matches end-of-string for in-flight streams).
  out = out.replace(/```([^\n]*)\n([\s\S]*?)(?:```|$)/g, (full, info: string, body: string) => {
    if (KEYWORD_RE.test(info)) return '';
    if (/^[a-z0-9]*$/i.test(info.trim()) && KEYWORD_RE.test(body.slice(0, 200))) return '';
    return full;
  });

  // Pass 2: bare JSON objects (no fence) at the end of the text whose
  // top-level key is "authorities" or "compliance" / "compliance_check".
  // We anchor with a positive look-back for a blank line or start of
  // string to avoid eating an inline `{ "authorities": ... }` mention.
  out = out.replace(
    /(^|\n\s*\n)\s*\{[\s\S]*?"(authorities|compliance|compliance_check)"\s*:[\s\S]*?\}\s*(?=\n\s*\n|\s*$)/g,
    (_full, lead: string) => lead,
  );

  // Pass 3: collapse the trailing whitespace + dividers we leave behind.
  return out
    .replace(/\n[\s-]*\n{2,}/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function ChatPage() {
  const { chatId } = useParams<{ chatId?: string }>();
  if (!chatId) {
    return (
      <div className="grid grid-cols-[260px_1fr] h-screen overflow-hidden">
        <ChatSidebar />
        <div className="grid place-items-center text-ink/50">
          <div className="text-center">
            <div className="font-display text-2xl mb-2">Start a new research thread</div>
            <div className="text-sm">Select &quot;+ New&quot; in the sidebar.</div>
          </div>
        </div>
      </div>
    );
  }
  return <ChatView chatId={chatId} />;
}

function ChatView({ chatId }: { chatId: string }) {
  const [draft, setDraft] = useState('');
  const { streaming, send, abort, reset } = useChatStream();

  const { data, refetch } = useQuery<{ chat: ChatDTO; messages: MessageDTO[] }>({
    queryKey: ['chat', chatId],
    queryFn: () => api(`/api/chats/${chatId}`),
  });

  useEffect(() => {
    if (streaming?.done) {
      void refetch();
      reset();
    }
  }, [streaming?.done, refetch, reset]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    const text = draft;
    setDraft('');
    await send(chatId, text);
  }

  const provisionalCost = useMemo(() => {
    if (!streaming) return 0;
    const o = streaming.usage.output_tokens ?? streaming.text.length / 4;
    const i = streaming.usage.input_tokens ?? 0;
    return (i * 3 + o * 15) / 1_000_000;
  }, [streaming]);

  return (
    // h-screen + overflow-hidden on the outer grid so the sidebar and chat
    // column are each capped at the viewport. The chat column is a flex
    // column with min-h-0 (the magic that lets a flex child actually scroll
    // instead of forcing the parent taller), header and form are
    // shrink-to-content, and only <main> scrolls between them.
    <div className="grid grid-cols-[260px_1fr] h-screen overflow-hidden bg-paper">
      <ChatSidebar />
      <div className="flex flex-col min-h-0">
        <header className="shrink-0 px-7 py-4 border-b border-ink/10 flex items-center justify-between">
          <div className="font-display text-lg">{data?.chat.title ?? 'Loading…'}</div>
          <div className="font-mono text-xs text-ink/50">{data?.messages.length ?? 0} messages</div>
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-7 py-6 max-w-4xl w-full">
            {data?.messages.map((m) => (
              <MessageBlock key={m.id} message={m} />
            ))}
            {streaming && (
              <>
                {/*
                  Optimistic user-message echo. The persisted user-message
                  row only appears on refetch (after `done`), so without
                  this block users see their textarea clear and then
                  silence for a few seconds while the model thinks. Mirrors
                  the styling of the persisted "You" block in MessageBlock.
                */}
                {streaming.user_message && (
                  <div className="mb-4">
                    <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">You</div>
                    <div className="bg-ink/5 rounded p-3 font-body whitespace-pre-wrap">
                      {streaming.user_message}
                    </div>
                  </div>
                )}
                <div className="mb-6 space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-xs uppercase tracking-wider text-ink/50">Assistant</div>
                    <StreamingStatus streaming={streaming} />
                  </div>
                  {streaming.text ? (
                    <Markdown>{stripSidecars(streaming.text)}</Markdown>
                  ) : (
                    <div className="text-sm text-ink/50 italic">
                      Working on it{streaming.tool_uses.length === 0 ? '…' : ''}
                    </div>
                  )}
                  <CostLedger
                    usage={streaming.usage}
                    cost_usd={streaming.cost ?? provisionalCost}
                    model_id={data?.chat.default_model_id ?? undefined}
                    provisional={!streaming.done}
                  />
                  {streaming.error && (
                    <div className="text-oxblood text-sm mt-2">{streaming.error}</div>
                  )}
                </div>
              </>
            )}
          </div>
        </main>

        <form onSubmit={onSubmit} className="shrink-0 px-7 py-4 border-t border-ink/10 bg-paper">
          <div className="max-w-4xl w-full">
            <div className="flex gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask a tax research question…"
                rows={3}
                className="flex-1 px-3 py-2 border border-ink/20 rounded font-body resize-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void onSubmit(e);
                }}
              />
              {streaming && !streaming.done ? (
                <button
                  type="button"
                  onClick={abort}
                  className="px-4 py-2 border border-oxblood text-oxblood rounded"
                >
                  Stop
                </button>
              ) : (
                <button type="submit" className="px-4 py-2 bg-ink text-paper rounded">
                  Send
                </button>
              )}
            </div>
            <div className="text-[10px] text-ink/40 mt-1">⌘/Ctrl + Enter to send</div>
          </div>
        </form>
      </div>
    </div>
  );
}

// Live status line for the streaming assistant turn. Three layers of info:
//   1. an animated dot to signal "still working"
//   2. a short narration of what's happening right now ("Searching irs.gov",
//      "Running code", "Drafting answer")
//   3. an elapsed timer that ticks every second so the user can tell the
//      request hasn't stalled
function StreamingStatus({ streaming }: { streaming: StreamingMessage }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (streaming.done) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [streaming.done]);

  const elapsedSec = Math.max(0, Math.floor((Date.now() - streaming.started_at) / 1000));
  const narration = describeActivity(streaming);

  return (
    <div className="text-xs text-ink/60 flex items-center gap-2 whitespace-nowrap">
      {!streaming.done && (
        <span className="inline-flex h-2 w-2 rounded-full bg-moss animate-pulse" aria-hidden />
      )}
      <span>{streaming.done ? 'Finished' : narration}</span>
      <span className="text-ink/30">·</span>
      <span className="font-mono">{elapsedSec}s</span>
    </div>
  );
}

function describeActivity(streaming: StreamingMessage): string {
  if (streaming.error) return 'Errored';
  // Most recent in-flight tool use wins; fallback to "Drafting" once text
  // has started flowing, otherwise "Thinking".
  const open = [...streaming.tool_uses].reverse().find((t) => !t.status);
  if (open) {
    if (open.tool_name === 'web_fetch') {
      const url = (open.input as { url?: string } | null)?.url;
      const host = url ? safeHost(url) : null;
      return host ? `Fetching ${host}` : 'Fetching source';
    }
    if (open.tool_name === 'web_search') {
      const q = (open.input as { query?: string } | null)?.query;
      return q ? `Searching: ${q.slice(0, 60)}` : 'Searching the web';
    }
    if (open.tool_name === 'code_execution') return 'Running code';
    return `Running ${open.tool_name}`;
  }
  if (streaming.text.length > 0) return 'Drafting answer';
  return 'Thinking';
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function MessageBlock({ message: m }: { message: MessageDTO }) {
  if (m.role === 'user') {
    return (
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">You</div>
        <div className="bg-ink/5 rounded p-3 font-body">{m.content}</div>
      </div>
    );
  }
  if (m.role === 'system_note') {
    return <div className="my-3 text-xs text-ink/50 italic">{m.content}</div>;
  }
  return (
    // Wrap the assistant body + panels in a vertical-rhythm container so
    // every block (Markdown prose, Authorities, Compliance, Skills, Cost)
    // gets the same 12px gap. Reduces the previous mish-mash of mt-4 +
    // implicit margin into a single uniform stack.
    <div className="mb-6 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs uppercase tracking-wider text-ink/50">Assistant</div>
        <MessageActions message={m} />
      </div>
      <Markdown>{stripSidecars(m.content)}</Markdown>
      <AuthoritiesPanel authorities={(m.authorities as never) ?? []} />
      <CompliancePanel check={m.compliance_check} />
      <SkillsPanel skills={m.skills} />
      <CostLedger usage={m.usage} cost_usd={m.cost_usd} model_id={m.model_id} />
    </div>
  );
}

// ── Per-message export tools ──────────────────────────────────────────────
// Copy puts a clean Markdown rendering on the clipboard (sans sidecar
// JSON). PDF opens a popup window with the same content laid out for
// print and triggers the browser's print dialog — the user picks
// "Save as PDF" from there. No PDF library to ship.
function MessageActions({ message: m }: { message: MessageDTO }) {
  const [copied, setCopied] = useState(false);

  const exportMd = useMemo(() => buildExportMarkdown(m), [m]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportMd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for browsers / contexts where clipboard is blocked.
      const ta = document.createElement('textarea');
      ta.value = exportMd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const onPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadMessagePdf(m, exportMd);
    } catch (err) {
      console.error('pdf export failed', err);
      alert(`PDF export failed: ${(err as Error).message}`);
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="text-xs flex items-center gap-3">
      <button
        type="button"
        onClick={onCopy}
        className="text-ink/50 hover:text-ink underline-offset-2 hover:underline"
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
      <button
        type="button"
        onClick={onPdf}
        disabled={pdfBusy}
        className="text-ink/50 hover:text-ink underline-offset-2 hover:underline disabled:opacity-50"
        title="Download a formatted PDF of this response"
      >
        {pdfBusy ? 'Building PDF…' : 'Download PDF'}
      </button>
    </div>
  );
}

function buildExportMarkdown(m: MessageDTO): string {
  const lines: string[] = [];
  lines.push(stripSidecars(m.content).trim());

  const auths = (m.authorities ?? []) as Array<{
    cite: string;
    type?: string;
    weight?: string;
    source?: string;
    verified_this_turn?: boolean;
  }>;
  if (auths.length > 0) {
    lines.push('', '## Authorities');
    auths.forEach((a, i) => {
      const status = a.verified_this_turn ? '✓ verified' : 'unverified';
      const meta = [a.type, a.weight ? `weight: ${a.weight}` : null].filter(Boolean).join(' · ');
      lines.push(`${i + 1}. **${a.cite}** — ${status}`);
      if (meta) lines.push(`   ${meta}`);
      if (a.source) lines.push(`   ${a.source}`);
    });
  }

  const c = m.compliance_check as Record<string, unknown> | null | undefined;
  if (c) {
    lines.push('', '## Compliance');
    if (typeof c.engagement_type === 'string') lines.push(`**Engagement:** ${c.engagement_type}`);
    if (typeof c.confidence_band === 'string') lines.push(`**Confidence:** ${c.confidence_band}`);
    if (typeof c.notes === 'string') lines.push('', c.notes);
  }

  if (m.cost_usd != null) {
    lines.push(
      '',
      '---',
      `_Generated by Vibe Tax Research · model: ${m.model_id ?? 'unknown'} · cost: $${Number(m.cost_usd).toFixed(4)}_`,
    );
  }
  return lines.join('\n');
}

// Generate a real, downloadable PDF (selectable text, ~25KB per turn) by
// streaming the message's Markdown export into jsPDF. We don't rasterize
// the DOM — that would produce big image PDFs with no text reflow, and
// would lose the Fraunces / Source Serif faces (jsPDF doesn't ship them
// either, but standard Times produces a clean, archivable document).
async function downloadMessagePdf(m: MessageDTO, markdown: string) {
  // Lazy-load jsPDF so the chat-page route doesn't pay for ~250KB on
  // first paint. The dynamic import only runs when the user clicks
  // Download PDF.
  const { default: jsPDF } = await import('jspdf');

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 54; // 0.75in
  const contentW = pageW - margin * 2;

  let y = margin;
  const ensureSpace = (need: number) => {
    if (y + need > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // ── Header ────────────────────────────────────────────────────────────
  doc.setFont('times', 'bold');
  doc.setFontSize(16);
  doc.text('Tax research response', margin, y);
  y += 22;
  doc.setFont('times', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110);
  const created = new Date(m.created_at).toLocaleString();
  const headerMeta = `Generated ${created} · model ${m.model_id ?? 'unknown'}${
    m.cost_usd != null ? ` · cost $${Number(m.cost_usd).toFixed(4)}` : ''
  }`;
  doc.text(headerMeta, margin, y);
  y += 8;
  doc.setDrawColor(220);
  doc.line(margin, y, pageW - margin, y);
  y += 16;
  doc.setTextColor(26);

  // ── Body ──────────────────────────────────────────────────────────────
  // Walk the markdown line-by-line so we can map # / ## / ### / --- /
  // bullet / number / blockquote into native jsPDF formatting. Inline
  // **bold** runs are honored by splitting each paragraph into
  // bold/normal segments.
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;

    // Blank line → paragraph gap.
    if (raw.trim() === '') {
      y += 6;
      continue;
    }

    // Horizontal rule.
    if (/^---+\s*$/.test(raw.trim())) {
      ensureSpace(14);
      y += 4;
      doc.setDrawColor(220);
      doc.line(margin, y, pageW - margin, y);
      y += 14;
      continue;
    }

    // Headings.
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!.trim();
      const sizeMap = [16, 14, 12, 11];
      const topPad = [16, 14, 12, 8];
      ensureSpace(sizeMap[level - 1]! + topPad[level - 1]!);
      y += topPad[level - 1]!;
      doc.setFont('times', 'bold');
      doc.setFontSize(sizeMap[level - 1]!);
      const wrapped = doc.splitTextToSize(text, contentW) as string[];
      for (const w of wrapped) {
        ensureSpace(sizeMap[level - 1]! + 2);
        doc.text(w, margin, y);
        y += sizeMap[level - 1]! + 2;
      }
      y += 2;
      doc.setFont('times', 'normal');
      doc.setFontSize(11);
      continue;
    }

    // Bulleted / numbered list item.
    const bullet = raw.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const indent = (bullet[1]!.length / 2) * 8;
      const marker = /\d/.test(bullet[2]!) ? bullet[2]! : '•';
      const text = bullet[3]!.trim();
      doc.setFont('times', 'normal');
      doc.setFontSize(11);
      const wrapped = doc.splitTextToSize(text, contentW - 18 - indent) as string[];
      ensureSpace(14 * wrapped.length);
      for (let li = 0; li < wrapped.length; li++) {
        if (li === 0) doc.text(marker, margin + indent, y);
        const segments = parseInline(wrapped[li]!);
        renderInline(doc, segments, margin + indent + 16, y);
        y += 14;
      }
      continue;
    }

    // Blockquote.
    if (/^>\s+/.test(raw)) {
      const text = raw.replace(/^>\s+/, '').trim();
      doc.setFont('times', 'italic');
      doc.setFontSize(11);
      doc.setTextColor(80);
      const wrapped = doc.splitTextToSize(text, contentW - 14) as string[];
      ensureSpace(14 * wrapped.length);
      for (const w of wrapped) {
        doc.setDrawColor(180);
        doc.line(margin + 2, y - 9, margin + 2, y + 1);
        doc.text(w, margin + 14, y);
        y += 14;
      }
      doc.setFont('times', 'normal');
      doc.setTextColor(26);
      continue;
    }

    // Plain paragraph.
    doc.setFont('times', 'normal');
    doc.setFontSize(11);
    const wrapped = doc.splitTextToSize(raw, contentW) as string[];
    for (const w of wrapped) {
      ensureSpace(14);
      const segments = parseInline(w);
      renderInline(doc, segments, margin, y);
      y += 14;
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('times', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(
      'Vibe Tax Research · AI-generated; verify all citations before reliance.',
      margin,
      pageH - 30,
    );
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, pageH - 30, { align: 'right' });
  }

  const slug = (m.id.slice(0, 8) || 'response').toLowerCase();
  const stamp = new Date(m.created_at).toISOString().slice(0, 10);
  doc.save(`vibe-tax-research-${stamp}-${slug}.pdf`);
}

// Split a single line into runs of bold / normal so **like this** renders
// with the right weight. URLs are pulled out so jsPDF can attach them
// as link annotations.
type InlineSeg = { text: string; bold?: boolean; href?: string };
function parseInline(line: string): InlineSeg[] {
  const segs: InlineSeg[] = [];
  // Walk **bold** spans first, then check each plain run for URLs.
  const boldRe = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let bm: RegExpExecArray | null;
  while ((bm = boldRe.exec(line)) !== null) {
    if (bm.index > cursor) segs.push(...splitUrls(line.slice(cursor, bm.index), false));
    segs.push({ text: bm[1]!, bold: true });
    cursor = bm.index + bm[0].length;
  }
  if (cursor < line.length) segs.push(...splitUrls(line.slice(cursor), false));
  return segs;
}
function splitUrls(text: string, bold: boolean): InlineSeg[] {
  const out: InlineSeg[] = [];
  const re = /(https?:\/\/[^\s)]+)/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) out.push({ text: text.slice(cursor, m.index), bold });
    out.push({ text: m[1]!, bold, href: m[1]! });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), bold });
  return out.length > 0 ? out : [{ text, bold }];
}
function renderInline(doc: import('jspdf').jsPDF, segs: InlineSeg[], x: number, y: number): void {
  let cx = x;
  for (const s of segs) {
    if (!s.text) continue;
    doc.setFont('times', s.bold ? 'bold' : 'normal');
    if (s.href) doc.setTextColor(122, 42, 26); // oxblood
    doc.text(s.text, cx, y);
    if (s.href) {
      const w = doc.getTextWidth(s.text);
      doc.link(cx, y - 9, w, 12, { url: s.href });
      doc.setTextColor(26);
    }
    cx += doc.getTextWidth(s.text);
  }
}

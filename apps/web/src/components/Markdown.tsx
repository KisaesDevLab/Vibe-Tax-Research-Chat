// Phase 14 — markdown rendering with GFM.
//
// We don't load @tailwindcss/typography, so the previous `prose` class was
// a no-op. Hand-roll the styles that matter for tax-research output:
// vertical rhythm at every section break (h2/h3 + thematic break ---) so
// "Key details" and "Planning notes" don't run together as one flat wall.
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  // Section headings: extra top margin opens space between sections; the
  // first heading gets first:mt-0 so we don't leave a gap above the very
  // first line.
  h1: (p) => (
    <h1 {...p} className="font-display text-2xl mt-8 mb-3 first:mt-0 border-b border-ink/10 pb-1" />
  ),
  h2: (p) => <h2 {...p} className="font-display text-xl mt-8 mb-3 first:mt-0" />,
  h3: (p) => <h3 {...p} className="font-display text-base mt-6 mb-2 first:mt-0" />,
  h4: (p) => (
    <h4
      {...p}
      className="font-display text-sm uppercase tracking-wider text-ink/70 mt-5 mb-2 first:mt-0"
    />
  ),
  // `---` thematic break: full breathing room above + below so it reads
  // as a real divider, not just a hairline.
  hr: (p) => <hr {...p} className="my-7 border-t border-ink/15" />,
  p: (p) => <p {...p} className="leading-relaxed mb-3 last:mb-0" />,
  ul: (p) => <ul {...p} className="list-disc pl-5 space-y-1 mb-3" />,
  ol: (p) => <ol {...p} className="list-decimal pl-5 space-y-1 mb-3" />,
  li: (p) => <li {...p} className="leading-relaxed" />,
  blockquote: (p) => (
    <blockquote {...p} className="border-l-2 border-ink/20 pl-4 italic text-ink/80 my-4" />
  ),
  // Inline code vs fenced code blocks — react-markdown calls the same
  // component for both; the multiline shape gets the block treatment.
  code: ({ className, children, ...rest }) => {
    const text = String(children ?? '');
    if (text.includes('\n')) {
      return (
        <pre className="bg-ink/5 border border-ink/10 rounded p-3 overflow-x-auto font-mono text-xs my-3">
          <code className={className} {...rest}>
            {children}
          </code>
        </pre>
      );
    }
    return (
      <code
        className="font-mono text-[0.9em] bg-ink/5 border border-ink/10 rounded px-1 py-0.5"
        {...rest}
      >
        {children}
      </code>
    );
  },
  table: (p) => (
    <div className="my-4 overflow-x-auto">
      <table {...p} className="w-full text-sm border-collapse" />
    </div>
  ),
  th: (p) => <th {...p} className="text-left border-b border-ink/15 px-2 py-1 font-display" />,
  td: (p) => <td {...p} className="border-b border-ink/5 px-2 py-1 align-top" />,
  a: (p) => (
    <a
      {...p}
      className="underline text-oxblood hover:text-oxblood/80"
      target="_blank"
      rel="noreferrer"
    />
  ),
  strong: (p) => <strong {...p} className="font-semibold" />,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm font-body leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

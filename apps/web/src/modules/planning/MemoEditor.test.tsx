// Guards the one assumption the memo feature rests on: that the editor
// round-trips markdown faithfully. tiptap-markdown and TipTap are on
// different major lines, so a silent serializer regression here would
// quietly corrupt saved memos — hence a real mount, not a mock.
//
// The round-trip is driven through the `incoming` prop (the Claude-draft
// path), which loads content and marks the document dirty, so Save becomes
// clickable without simulating keystrokes into a contenteditable.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoEditor } from './MemoEditor';

const SAMPLE = [
  '# Situation',
  '',
  'The client runs an **S corporation** with *material* profit.',
  '',
  '## Modeled plan',
  '',
  '- Augusta rule, 14 days',
  '- Accountable plan',
  '',
  '1. First step',
  '2. Second step',
  '',
  '> Draft — verify every figure.',
  '',
  'See `IRC §280A(g)` and [the memo](https://example.com/memo).',
].join('\n');

async function roundTrip(markdown: string): Promise<string> {
  const onSave = vi.fn();
  render(<MemoEditor value="" editable saving={false} onSave={onSave} incoming={markdown} />);
  const save = await screen.findByRole('button', { name: /save memo/i });
  await waitFor(() => expect(save).not.toBeDisabled());
  fireEvent.click(save);
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls[0]![0] as string;
}

describe('MemoEditor markdown round-trip', () => {
  it('preserves headings, emphasis, lists, quotes, code, and links', async () => {
    const out = await roundTrip(SAMPLE);

    expect(out).toContain('# Situation');
    expect(out).toContain('## Modeled plan');
    expect(out).toContain('**S corporation**');
    expect(out).toMatch(/[*_]material[*_]/);
    expect(out).toContain('Augusta rule, 14 days');
    expect(out).toContain('First step');
    expect(out).toContain('> Draft — verify every figure.');
    expect(out).toContain('`IRC §280A(g)`');
    expect(out).toContain('https://example.com/memo');
    // Section signs and em dashes must survive verbatim — memos are full of them.
    expect(out).toContain('§280A(g)');
  });

  it('does not emit HTML tags for ordinary formatting', async () => {
    const out = await roundTrip('Plain **bold** text.\n');
    expect(out).not.toMatch(/<\/?(strong|em|p|h1)\b/);
    expect(out).toContain('**bold**');
  });

  it('renders read-only without save controls when the plan is locked', () => {
    render(<MemoEditor value="# Locked" editable={false} saving={false} onSave={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /save memo/i })).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});

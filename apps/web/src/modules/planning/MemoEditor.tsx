// Plan memo — WYSIWYG editing over a markdown source of truth.
//
// Markdown stays canonical (see plan_memos.body_markdown): TipTap parses it
// into a ProseMirror document for editing and serializes it straight back on
// save, so the stored memo remains diffable and renders through the same
// <Markdown> component as the rest of the app. Nothing here stores HTML.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown as MarkdownExt } from 'tiptap-markdown';
import { Markdown } from '../../components/Markdown';

export interface MemoState {
  body_markdown: string;
  claude_drafted: boolean;
  updated_at: string | null;
}

interface ToolbarButton {
  label: string;
  title: string;
  /** Active-state probe; omitted for one-shot commands like undo. */
  isActive?: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const BUTTONS: ToolbarButton[][] = [
  [
    {
      label: 'B',
      title: 'Bold (Ctrl+B)',
      isActive: (e) => e.isActive('bold'),
      run: (e) => e.chain().focus().toggleBold().run(),
    },
    {
      label: 'I',
      title: 'Italic (Ctrl+I)',
      isActive: (e) => e.isActive('italic'),
      run: (e) => e.chain().focus().toggleItalic().run(),
    },
    {
      label: '</>',
      title: 'Inline code',
      isActive: (e) => e.isActive('code'),
      run: (e) => e.chain().focus().toggleCode().run(),
    },
  ],
  [
    {
      label: 'H1',
      title: 'Heading 1',
      isActive: (e) => e.isActive('heading', { level: 1 }),
      run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: 'H2',
      title: 'Heading 2',
      isActive: (e) => e.isActive('heading', { level: 2 }),
      run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: 'H3',
      title: 'Heading 3',
      isActive: (e) => e.isActive('heading', { level: 3 }),
      run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
    },
  ],
  [
    {
      label: '• List',
      title: 'Bullet list',
      isActive: (e) => e.isActive('bulletList'),
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      label: '1. List',
      title: 'Numbered list',
      isActive: (e) => e.isActive('orderedList'),
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      label: 'Quote',
      title: 'Blockquote',
      isActive: (e) => e.isActive('blockquote'),
      run: (e) => e.chain().focus().toggleBlockquote().run(),
    },
    {
      label: '—',
      title: 'Horizontal rule',
      run: (e) => e.chain().focus().setHorizontalRule().run(),
    },
  ],
];

function Toolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  // Toolbar actives track selection, which changes without a React render;
  // subscribe to the editor's own transactions to stay in sync.
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    editor.on('transaction', bump);
    editor.on('selectionUpdate', bump);
    return () => {
      editor.off('transaction', bump);
      editor.off('selectionUpdate', bump);
    };
  }, [editor]);

  const promptLink = useCallback(() => {
    const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
    const url = window.prompt('Link URL (blank to remove):', prev);
    if (url === null) return;
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }, [editor]);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-ink/10 px-2 py-1.5 bg-paper rounded-t">
      {BUTTONS.map((group, gi) => (
        <div key={gi} className="flex items-center gap-1 pr-1.5 mr-0.5 border-r border-ink/10">
          {group.map((b) => {
            const active = b.isActive?.(editor) ?? false;
            return (
              <button
                key={b.label}
                type="button"
                title={b.title}
                disabled={disabled}
                aria-pressed={active}
                onClick={() => b.run(editor)}
                className={`min-w-[1.9rem] px-1.5 py-0.5 rounded text-xs border disabled:opacity-40 ${
                  active
                    ? 'bg-ink text-paper border-ink'
                    : 'border-ink/15 hover:bg-ink/5 text-ink/80'
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      ))}
      <button
        type="button"
        title="Link"
        disabled={disabled}
        aria-pressed={editor.isActive('link')}
        onClick={promptLink}
        className={`px-1.5 py-0.5 rounded text-xs border disabled:opacity-40 ${
          editor.isActive('link')
            ? 'bg-ink text-paper border-ink'
            : 'border-ink/15 hover:bg-ink/5 text-ink/80'
        }`}
      >
        Link
      </button>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          disabled={disabled || !editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
          className="px-1.5 py-0.5 rounded text-xs border border-ink/15 hover:bg-ink/5 disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Shift+Z)"
          disabled={disabled || !editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
          className="px-1.5 py-0.5 rounded text-xs border border-ink/15 hover:bg-ink/5 disabled:opacity-40"
        >
          Redo
        </button>
      </div>
    </div>
  );
}

export interface MemoEditorProps {
  /** Saved memo markdown, or '' when none exists yet. */
  value: string;
  editable: boolean;
  saving: boolean;
  onSave: (markdown: string) => void;
  /** Markdown to load into the editor (Claude draft). Changing it replaces
   *  the document, so callers must clear it after it is consumed. */
  incoming?: string | null;
  onIncomingConsumed?: () => void;
}

export function MemoEditor({
  value,
  editable,
  saving,
  onSave,
  incoming,
  onIncomingConsumed,
}: MemoEditorProps) {
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  // Latest saved text, so the reset-on-external-change effect below can tell
  // "server sent something new" from "our own save echoed back".
  const savedRef = useRef(value);

  const editor = useEditor(
    {
      extensions: [
        // StarterKit already bundles Link in TipTap v3 — configure it here
        // rather than adding the extension again, which triggers a
        // duplicate-name warning and double-registers its plugins.
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false, autolink: false },
        }),
        MarkdownExt.configure({ html: false, breaks: false, transformPastedText: true }),
      ],
      content: value,
      editable,
      onUpdate: () => setDirty(true),
      editorProps: {
        attributes: {
          class:
            'prose-memo min-h-[18rem] max-h-[38rem] overflow-y-auto px-3 py-2 focus:outline-none text-sm',
          'aria-label': 'Plan memo editor',
        },
      },
    },
    [],
  );

  // tiptap-markdown augments editor.storage at runtime but ships no
  // declaration for it, so reach through a narrow local shape.
  const currentMarkdown = useCallback(() => {
    if (!editor) return '';
    const storage = editor.storage as unknown as {
      markdown?: { getMarkdown: () => string };
    };
    return storage.markdown?.getMarkdown() ?? '';
  }, [editor]);

  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  // Adopt a newly saved/fetched value only when the user has nothing
  // in-flight — never clobber unsaved edits with a background refetch.
  useEffect(() => {
    if (!editor) return;
    if (value === savedRef.current) return;
    savedRef.current = value;
    if (dirty) return;
    editor.commands.setContent(value);
  }, [editor, value, dirty]);

  // Claude draft arrives: replace the document and mark dirty so the user
  // must consciously save it.
  useEffect(() => {
    if (!editor || incoming == null) return;
    editor.commands.setContent(incoming);
    setDirty(true);
    onIncomingConsumed?.();
  }, [editor, incoming, onIncomingConsumed]);

  const handleSave = useCallback(() => {
    if (!editor) return;
    const md = currentMarkdown();
    savedRef.current = md;
    setDirty(false);
    onSave(md);
  }, [editor, currentMarkdown, onSave]);

  const handleRevert = useCallback(() => {
    if (!editor) return;
    editor.commands.setContent(savedRef.current);
    setDirty(false);
  }, [editor]);

  // Ctrl/Cmd+S saves without leaving the keyboard.
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, handleSave]);

  const previewMarkdown = useMemo(
    () => (preview ? currentMarkdown() : ''),
    [preview, currentMarkdown],
  );

  if (!editor) return <div className="text-sm text-ink/40">Loading editor…</div>;

  return (
    <div className="mt-2">
      <div className="border border-ink/15 rounded bg-white">
        {editable && <Toolbar editor={editor} disabled={saving} />}
        {preview ? (
          <div className="px-3 py-2 min-h-[18rem] max-h-[38rem] overflow-y-auto">
            {previewMarkdown.trim() ? (
              <Markdown>{previewMarkdown}</Markdown>
            ) : (
              <span className="text-sm text-ink/40">Nothing to preview yet.</span>
            )}
          </div>
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className="px-2.5 py-1 border border-ink/20 rounded text-sm hover:bg-ink/5"
        >
          {preview ? 'Back to editing' : 'Preview'}
        </button>
        {editable && (
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className="px-2.5 py-1 rounded text-sm bg-ink text-paper hover:bg-ink/90 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save memo'}
            </button>
            <button
              type="button"
              onClick={handleRevert}
              disabled={saving || !dirty}
              className="px-2.5 py-1 border border-ink/20 rounded text-sm hover:bg-ink/5 disabled:opacity-40"
            >
              Discard changes
            </button>
          </>
        )}
        <span className="text-xs text-ink/50">
          {!editable
            ? 'Read-only — this plan is archived.'
            : dirty
              ? 'Unsaved changes'
              : 'All changes saved'}
        </span>
      </div>
    </div>
  );
}

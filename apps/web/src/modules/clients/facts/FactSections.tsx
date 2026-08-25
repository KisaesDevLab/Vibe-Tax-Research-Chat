// TP-3a — section-by-section fact pattern view + inline editors. Each
// section card flips into edit mode independently; Save prompts for the
// required change summary and hands the FULL updated pattern back to the
// parent (one new version per save).
import { useState } from 'react';
import type { FactPattern, FactSource } from '@vibe/shared';
import { SourceBadge } from './SourceBadge';
import {
  ARRAY_SECTIONS,
  DEPENDENT_FIELDS,
  ENTITY_FIELDS,
  INCOME_CHARACTERS,
  INCOME_SOURCE_FIELDS,
  type ArraySectionDef,
  type FieldDef,
} from './section-config';

type Row = Record<string, unknown>;

function FieldInput({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const base = 'border border-ink/20 rounded px-2 py-1 text-sm bg-white w-full';
  if (def.kind === 'select') {
    return (
      <select
        className={base}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">—</option>
        {def.options!.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (def.kind === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (def.kind === 'number') {
    return (
      <input
        type="number"
        className={base}
        value={value == null || value === '' ? '' : Number(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  }
  return (
    <input
      className={base}
      placeholder={def.placeholder}
      value={(value as string) ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

function displayValue(def: FieldDef, value: unknown): string {
  if (value == null || value === '') return '—';
  if (def.kind === 'checkbox') return value ? 'yes' : 'no';
  return String(value);
}

function SectionCard({
  title,
  editing,
  disabled,
  onEdit,
  onCancel,
  onSave,
  children,
}: {
  title: string;
  editing: boolean;
  disabled: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-ink/10 rounded p-4 bg-white">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-display text-lg">{title}</h3>
        {editing ? (
          <div className="flex gap-2">
            <button onClick={onCancel} className="px-2 py-1 border border-ink/20 rounded text-xs">
              Cancel
            </button>
            <button onClick={onSave} className="px-2 py-1 bg-ink text-paper rounded text-xs">
              Save…
            </button>
          </div>
        ) : (
          <button
            onClick={onEdit}
            disabled={disabled}
            className="px-2 py-1 border border-ink/20 rounded text-xs hover:bg-ink/5 disabled:opacity-50"
          >
            Edit
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function RowsTable({
  clientId,
  fields,
  rows,
  editing,
  onChange,
  empty,
  sourceless,
}: {
  clientId: string;
  fields: FieldDef[];
  rows: Row[];
  editing: boolean;
  onChange: (rows: Row[]) => void;
  empty: () => Row;
  sourceless?: boolean;
}) {
  if (!editing && rows.length === 0) {
    return <div className="text-ink/40 text-sm">None recorded.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
            {fields.map((f) => (
              <th key={f.key} className="py-1.5 pr-3">
                {f.label}
              </th>
            ))}
            <th className="py-1.5">{editing ? '' : 'Source'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-ink/5">
              {fields.map((f) => (
                <td key={f.key} className="py-1.5 pr-3 align-top">
                  {editing ? (
                    <FieldInput
                      def={f}
                      value={row[f.key]}
                      onChange={(v) => {
                        const next = rows.map((r, j) => (j === i ? { ...r, [f.key]: v } : r));
                        onChange(next);
                      }}
                    />
                  ) : (
                    displayValue(f, row[f.key])
                  )}
                </td>
              ))}
              <td className="py-1.5 align-top text-right">
                {editing ? (
                  <button
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                    className="text-oxblood text-xs underline"
                  >
                    Remove
                  </button>
                ) : sourceless ? null : (
                  <SourceBadge
                    clientId={clientId}
                    sources={row.sources as FactSource[] | undefined}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <button
          onClick={() => onChange([...rows, empty()])}
          className="mt-2 px-2 py-1 border border-ink/20 rounded text-xs hover:bg-ink/5"
        >
          + Add
        </button>
      )}
    </div>
  );
}

export function FactSections({
  clientId,
  facts,
  disabled,
  onSave,
}: {
  clientId: string;
  facts: FactPattern;
  disabled: boolean;
  /** Receives the full updated pattern; resolves when persisted (or throws). */
  onSave: (next: FactPattern, sectionTitle: string) => Promise<void>;
}) {
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [draft, setDraft] = useState<FactPattern | null>(null);

  const working = editingSection && draft ? draft : facts;

  function beginEdit(section: string) {
    setDraft(structuredClone(facts));
    setEditingSection(section);
  }
  function cancel() {
    setEditingSection(null);
    setDraft(null);
  }
  async function save(sectionTitle: string) {
    if (!draft) return;
    await onSave(draft, sectionTitle);
    setEditingSection(null);
    setDraft(null);
  }
  function patchDraft(patch: Partial<FactPattern>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  const cardProps = (key: string, title: string) => ({
    title,
    editing: editingSection === key,
    disabled: disabled || (editingSection !== null && editingSection !== key),
    onEdit: () => beginEdit(key),
    onCancel: cancel,
    onSave: () => void save(title),
  });

  return (
    <div className="space-y-4">
      <SectionCard {...cardProps('entity', 'Entity')}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          {ENTITY_FIELDS.map((f) => (
            <div key={f.key}>
              <div className="text-[11px] uppercase tracking-wider text-ink/40">{f.label}</div>
              {editingSection === 'entity' ? (
                <FieldInput
                  def={f}
                  value={(working.entity as Row)[f.key]}
                  onChange={(v) => patchDraft({ entity: { ...working.entity, [f.key]: v } })}
                />
              ) : (
                <div>{displayValue(f, (working.entity as Row)[f.key])}</div>
              )}
            </div>
          ))}
        </div>
        {editingSection !== 'entity' && (
          <div className="mt-2">
            <SourceBadge clientId={clientId} sources={facts.entity.sources} />
          </div>
        )}
      </SectionCard>

      {ARRAY_SECTIONS.map((def: ArraySectionDef) => (
        <SectionCard key={def.section} {...cardProps(def.section, def.title)}>
          <RowsTable
            clientId={clientId}
            fields={def.fields}
            rows={working[def.section] as unknown as Row[]}
            editing={editingSection === def.section}
            onChange={(rows) => patchDraft({ [def.section]: rows } as Partial<FactPattern>)}
            empty={def.empty}
          />
        </SectionCard>
      ))}

      <SectionCard {...cardProps('income', 'Income')}>
        <div className="text-[11px] uppercase tracking-wider text-ink/40 mb-1">Characters</div>
        {editingSection === 'income' ? (
          <div className="flex flex-wrap gap-3 mb-3">
            {INCOME_CHARACTERS.map((c) => (
              <label key={c} className="text-sm flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={working.income.characters.includes(c)}
                  onChange={(e) =>
                    patchDraft({
                      income: {
                        ...working.income,
                        characters: e.target.checked
                          ? [...working.income.characters, c]
                          : working.income.characters.filter((x) => x !== c),
                      },
                    })
                  }
                />
                {c}
              </label>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1 mb-3">
            {working.income.characters.length === 0 && (
              <span className="text-ink/40 text-sm">None recorded.</span>
            )}
            {working.income.characters.map((c) => (
              <span
                key={c}
                className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink/10 text-ink/60"
              >
                {c}
              </span>
            ))}
          </div>
        )}
        <div className="text-[11px] uppercase tracking-wider text-ink/40 mb-1">Sources</div>
        <RowsTable
          clientId={clientId}
          fields={INCOME_SOURCE_FIELDS}
          rows={working.income.sources as unknown as Row[]}
          editing={editingSection === 'income'}
          onChange={(rows) =>
            patchDraft({
              income: { ...working.income, sources: rows as never },
            })
          }
          empty={() => ({ label: '', character: 'other' })}
        />
        {editingSection === 'income' && (
          <input
            className="mt-3 border border-ink/20 rounded px-2 py-1 text-sm w-full"
            placeholder="Notes"
            value={working.income.notes ?? ''}
            onChange={(e) =>
              patchDraft({ income: { ...working.income, notes: e.target.value || null } })
            }
          />
        )}
        {editingSection !== 'income' && working.income.notes && (
          <div className="text-sm text-ink/70 mt-2">{working.income.notes}</div>
        )}
      </SectionCard>

      <SectionCard {...cardProps('household', 'Household')}>
        <div className="mb-3">
          <div className="text-[11px] uppercase tracking-wider text-ink/40">Filing status</div>
          {editingSection === 'household' ? (
            <FieldInput
              def={{
                key: 'filingStatus',
                label: '',
                kind: 'select',
                options: ['single', 'mfj', 'mfs', 'hoh'],
              }}
              value={working.household.filingStatus}
              onChange={(v) =>
                patchDraft({ household: { ...working.household, filingStatus: v as never } })
              }
            />
          ) : (
            <div className="text-sm">{working.household.filingStatus ?? '—'}</div>
          )}
        </div>
        <div className="text-[11px] uppercase tracking-wider text-ink/40 mb-1">Dependents</div>
        <RowsTable
          clientId={clientId}
          fields={DEPENDENT_FIELDS}
          rows={working.household.dependents as unknown as Row[]}
          editing={editingSection === 'household'}
          onChange={(rows) =>
            patchDraft({ household: { ...working.household, dependents: rows as never } })
          }
          empty={() => ({ relationship: 'child' })}
          sourceless
        />
        {editingSection !== 'household' && (
          <div className="mt-2">
            <SourceBadge clientId={clientId} sources={facts.household.sources} />
          </div>
        )}
      </SectionCard>

      <SectionCard {...cardProps('narrative', 'Narrative')}>
        {editingSection === 'narrative' ? (
          <textarea
            className="border border-ink/20 rounded px-2 py-1 text-sm w-full min-h-32"
            value={working.narrative}
            onChange={(e) => patchDraft({ narrative: e.target.value })}
          />
        ) : working.narrative.trim() ? (
          <p className="text-sm whitespace-pre-wrap">{working.narrative}</p>
        ) : (
          <div className="text-ink/40 text-sm">No narrative yet.</div>
        )}
      </SectionCard>
    </div>
  );
}

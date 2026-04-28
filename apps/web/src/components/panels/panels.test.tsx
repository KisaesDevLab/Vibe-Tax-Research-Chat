// Phase 18-20 — smoke render tests for the three panels.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthoritiesPanel } from './AuthoritiesPanel';
import { CompliancePanel } from './CompliancePanel';
import { SkillsPanel } from './SkillsPanel';

describe('panels', () => {
  it('renders an authority with verified chip', () => {
    render(
      <AuthoritiesPanel
        authorities={[
          {
            cite: '26 U.S.C. § 199A(c)(1)',
            type: 'statute',
            weight: 'primary',
            source: 'https://uscode.house.gov/view.xhtml?req=199A',
            verified_this_turn: true,
          },
        ]}
      />,
    );
    expect(screen.getByText('26 U.S.C. § 199A(c)(1)')).toBeInTheDocument();
    expect(screen.getByText(/verified this turn/)).toBeInTheDocument();
  });

  it('renders the SSTS rows that are present', () => {
    render(<CompliancePanel check={{ ssts_1_1: { ok: true }, ssts_2_3: { ok: false, note: 'estimate flag' } }} />);
    expect(screen.getByText(/SSTS § 1.1/)).toBeInTheDocument();
    expect(screen.getByText(/estimate flag/)).toBeInTheDocument();
  });

  it('shows N of 8 slots used', () => {
    render(
      <SkillsPanel
        skills={[
          {
            skill_id: 'a',
            local_slug: 'cpa-pack-index',
            display_name: 'CPA pack index',
            version: '1.0.0',
            always_attached: true,
            is_dispatcher: true,
            is_compliance: false,
          },
        ]}
      />,
    );
    expect(screen.getByText(/1 of 8 slots used/)).toBeInTheDocument();
  });
});

// TP-9 — deliverable templates. Server-rendered React → static HTML →
// Chromium print. One data shape feeds every kind; the pitch deck hides
// strategy names until the plan is engaged (revealStrategies), and
// advisory strategies ALWAYS render as qualitative structural
// recommendations — never $0 rows.
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanDTO, YearResult } from '@vibe/shared';
import { PRINT_CSS, type Branding } from './theme.js';

export interface StrategyRenderData {
  id: string;
  name: string;
  modeled: boolean;
  riskRating: string;
  typicalSavingsBand: string;
  client: {
    headline: string;
    plainEnglish: string[];
    benefits: string[];
    steps: string[];
    clientCommitments: string[];
    teaser: string;
  };
  advisor: {
    summary: string;
    mechanics: string[];
    authority: Array<{ type: string; cite: string; note?: string }>;
    risks: string[];
    requirements: string[];
    reviewChecklist: string[];
  };
  engagement: {
    implementationEffort: string;
    annualMaintenance: string[];
    deliverables: string[];
  };
}

export interface RenderData {
  branding: Branding;
  plan: PlanDTO;
  clientName: string;
  baseline: YearResult[];
  scenario: YearResult[];
  scenarioLabel: string;
  strategies: StrategyRenderData[];
  revealStrategies: boolean;
  generatedAt: string;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function firstYearDelta(d: RenderData): number {
  if (d.baseline.length === 0 || d.scenario.length === 0) return 0;
  return d.scenario[0]!.totalBurden - d.baseline[0]!.totalBurden;
}
function cumulativeDelta(d: RenderData): number {
  const base = d.baseline.reduce((a, y) => a + y.totalBurden, 0);
  const scen = d.scenario.reduce((a, y) => a + y.totalBurden, 0);
  return scen - base;
}

function Disclaimer({ branding }: { branding: Branding }) {
  return (
    <div className="footer">
      {branding.firmName} · Deterministic projections from published tax tables; planning estimates,
      not tax advice or a filed return. Figures depend on facts as provided.
    </div>
  );
}

function ComparisonTable({ d }: { d: RenderData }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Year</th>
          <th className="num">Current path</th>
          <th className="num">With plan</th>
          <th className="num">Annual difference</th>
        </tr>
      </thead>
      <tbody>
        {d.baseline.map((y, i) => {
          const s = d.scenario[i];
          const delta = (s?.totalBurden ?? 0) - y.totalBurden;
          return (
            <tr key={y.year}>
              <td>{y.year}</td>
              <td className="num">{money(y.totalBurden)}</td>
              <td className="num">{money(s?.totalBurden ?? 0)}</td>
              <td className={`num ${delta < 0 ? 'savings' : 'cost'}`}>{money(delta)}</td>
            </tr>
          );
        })}
        <tr>
          <td>
            <strong>Cumulative</strong>
          </td>
          <td className="num">{money(d.baseline.reduce((a, y) => a + y.totalBurden, 0))}</td>
          <td className="num">{money(d.scenario.reduce((a, y) => a + y.totalBurden, 0))}</td>
          <td className={`num ${cumulativeDelta(d) < 0 ? 'savings' : 'cost'}`}>
            <strong>{money(cumulativeDelta(d))}</strong>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function AdvisoryBlock({ s }: { s: StrategyRenderData }) {
  return (
    <div className="qual">
      <p>
        <strong>Structural recommendation</strong> — savings not computed; typical impact band:{' '}
        <span className="band">{s.typicalSavingsBand}</span>
      </p>
      <p>{s.client.headline}</p>
    </div>
  );
}

// ── Advisor technical PDF ────────────────────────────────────────────────
function AdvisorPdf({ d }: { d: RenderData }) {
  return (
    <html>
      <head>
        <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      </head>
      <body style={{ ['--accent' as never]: d.branding.accent }}>
        <div className="page cover">
          <h1>{d.plan.title}</h1>
          <p className="muted">
            Advisor technical copy · {d.clientName} · {d.plan.years}-year window · engine{' '}
            {d.plan.engine_version}
          </p>
          <p className="small muted">Generated {d.generatedAt}</p>
        </div>
        <div className="page">
          <h2>Projection — {d.scenarioLabel}</h2>
          <ComparisonTable d={d} />
        </div>
        {d.strategies.map((s) => (
          <div className="page" key={s.id}>
            <h2>
              {s.name} <span className="band">{s.riskRating} risk</span>{' '}
              {!s.modeled && <span className="band">advisory</span>}
            </h2>
            <p>{s.advisor.summary}</p>
            {!s.modeled && <AdvisoryBlock s={s} />}
            <h3>Mechanics</h3>
            <ol>
              {s.advisor.mechanics.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ol>
            <h3>Authority</h3>
            <ul className="small">
              {s.advisor.authority.map((a, i) => (
                <li key={i}>
                  [{a.type}] {a.cite}
                  {a.note ? ` — ${a.note}` : ''}
                </li>
              ))}
            </ul>
            <h3>Risks</h3>
            <ul>
              {s.advisor.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <h3>Review checklist</h3>
            <ul className="small">
              {s.advisor.reviewChecklist.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ))}
        <Disclaimer branding={d.branding} />
      </body>
    </html>
  );
}

// ── Client PDF ───────────────────────────────────────────────────────────
function ClientPdf({ d }: { d: RenderData }) {
  return (
    <html>
      <head>
        <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      </head>
      <body style={{ ['--accent' as never]: d.branding.accent }}>
        <div className="page cover">
          <h1>Your tax plan</h1>
          <p className="muted">
            Prepared for {d.clientName} by {d.branding.firmName}
          </p>
          {firstYearDelta(d) < 0 && (
            <p style={{ marginTop: '18pt', fontSize: '15pt' }}>
              First-year projected savings:{' '}
              <span className="savings">{money(-firstYearDelta(d))}</span>
              <br />
              {d.plan.years}-year projected savings:{' '}
              <span className="savings">{money(-cumulativeDelta(d))}</span>
            </p>
          )}
        </div>
        <div className="page">
          <h2>Where the numbers land</h2>
          <ComparisonTable d={d} />
          <p className="small muted">
            Projections use published IRS figures and assume the facts you provided; they are
            planning estimates, not a guarantee of results.
          </p>
        </div>
        {d.strategies.map((s) => (
          <div className="page" key={s.id}>
            <h2>{s.client.headline}</h2>
            {s.client.plainEnglish.map((p, i) => (
              <p key={i} style={{ marginBottom: '6pt' }}>
                {p}
              </p>
            ))}
            {!s.modeled && <AdvisoryBlock s={s} />}
            <h3>What happens next</h3>
            <ul>
              {s.client.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ul>
            <h3>What we ask of you</h3>
            <ul>
              {s.client.clientCommitments.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        ))}
        <Disclaimer branding={d.branding} />
      </body>
    </html>
  );
}

// ── Per-strategy handout ─────────────────────────────────────────────────
function Handout({ d, strategy }: { d: RenderData; strategy: StrategyRenderData }) {
  const s = strategy;
  return (
    <html>
      <head>
        <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      </head>
      <body style={{ ['--accent' as never]: d.branding.accent }}>
        <div className="page">
          <h1>{s.name}</h1>
          <p className="muted small">
            {d.branding.firmName} · prepared for {d.clientName}
          </p>
          <h2>{s.client.headline}</h2>
          {s.client.plainEnglish.map((p, i) => (
            <p key={i} style={{ marginBottom: '6pt' }}>
              {p}
            </p>
          ))}
          <h3>Benefits</h3>
          <ul>
            {s.client.benefits.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          <h3>Steps</h3>
          <ul>
            {s.client.steps.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          {!s.modeled && <AdvisoryBlock s={s} />}
        </div>
        <Disclaimer branding={d.branding} />
      </body>
    </html>
  );
}

// ── Anonymized pitch deck ────────────────────────────────────────────────
// Names hidden until the plan is engaged: strategies appear as numbered
// opportunities with band + teaser only.
function PitchDeck({ d }: { d: RenderData }) {
  return (
    <html>
      <head>
        <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      </head>
      <body style={{ ['--accent' as never]: d.branding.accent }}>
        <div className="page cover">
          <h1>Tax planning opportunity review</h1>
          <p className="muted">Prepared for {d.clientName}</p>
          {cumulativeDelta(d) < 0 && (
            <p style={{ marginTop: '18pt', fontSize: '16pt' }}>
              Projected first-year net benefit:{' '}
              <span className="savings">{money(-firstYearDelta(d))}</span>
              <br />
              Projected {d.plan.years}-year cumulative benefit:{' '}
              <span className="savings">{money(-cumulativeDelta(d))}</span>
            </p>
          )}
          {d.plan.fee_plan?.flatFee != null && (
            <p style={{ marginTop: '10pt' }}>
              Engagement fee: <strong>{money(d.plan.fee_plan.flatFee)}</strong>
            </p>
          )}
        </div>
        <div className="page">
          <h2>The opportunities</h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Opportunity</th>
                <th>Typical impact</th>
              </tr>
            </thead>
            <tbody>
              {d.strategies.map((s, i) => (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td>{d.revealStrategies ? s.name : s.client.teaser}</td>
                  <td>
                    <span className="band">{s.typicalSavingsBand}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.revealStrategies && (
            <p className="small muted">
              Full strategy detail, authority citations, and implementation steps are delivered on
              engagement.
            </p>
          )}
        </div>
        <Disclaimer branding={d.branding} />
      </body>
    </html>
  );
}

// ── Slideshow (web view) ─────────────────────────────────────────────────
function Slideshow({ d }: { d: RenderData }) {
  return (
    <html>
      <head>
        <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
        <style
          dangerouslySetInnerHTML={{
            __html:
              '.page { min-height: 92vh; border-bottom: 2px solid #ddd; page-break-after: auto; }',
          }}
        />
      </head>
      <body style={{ ['--accent' as never]: d.branding.accent }}>
        <div className="page cover">
          <h1>{d.plan.title}</h1>
          <p className="muted">{d.clientName}</p>
        </div>
        <div className="page">
          <h2>Projection</h2>
          <ComparisonTable d={d} />
        </div>
        {d.strategies.map((s) => (
          <div className="page" key={s.id}>
            <h2>{d.revealStrategies ? s.name : s.client.teaser}</h2>
            <p>{s.client.headline}</p>
            <ul>
              {s.client.benefits.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            {!s.modeled && <AdvisoryBlock s={s} />}
          </div>
        ))}
      </body>
    </html>
  );
}

export type DeliverableKind = 'advisor-pdf' | 'client-pdf' | 'handout' | 'pitch-deck' | 'slideshow';

export function renderDeliverableHtml(
  kind: DeliverableKind,
  d: RenderData,
  handoutStrategyId?: string,
): string {
  let node: React.ReactElement;
  switch (kind) {
    case 'advisor-pdf':
      node = <AdvisorPdf d={d} />;
      break;
    case 'client-pdf':
      node = <ClientPdf d={d} />;
      break;
    case 'handout': {
      const s = d.strategies.find((x) => x.id === handoutStrategyId) ?? d.strategies[0];
      if (!s) throw new Error('no strategy for handout');
      node = <Handout d={d} strategy={s} />;
      break;
    }
    case 'pitch-deck':
      node = <PitchDeck d={d} />;
      break;
    case 'slideshow':
      node = <Slideshow d={d} />;
      break;
  }
  return `<!DOCTYPE html>${renderToStaticMarkup(node)}`;
}

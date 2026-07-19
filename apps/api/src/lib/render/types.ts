// TP-9 — the one data shape that feeds every deliverable renderer.
// Extracted from the retired React templates so the PDFKit renderer,
// the slideshow web view, and the data assembler share it.
import type { PlanDTO, YearResult } from '@vibe/shared';
import type { Branding } from './theme.js';

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

export type DeliverableKind = 'advisor-pdf' | 'client-pdf' | 'handout' | 'pitch-deck' | 'slideshow';

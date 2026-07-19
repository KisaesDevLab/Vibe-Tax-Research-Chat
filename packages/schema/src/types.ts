// TP-12 — validation gate result types. Every gate reports through the
// same error shape so the authoring pipeline and CI can render failures
// uniformly (gate → JSON-path → human message).
export type GateName = 'schema' | 'citation' | 'prose' | 'completeness';

export interface ValidationError {
  gate: GateName;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

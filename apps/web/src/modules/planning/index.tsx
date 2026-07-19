// TP-1 — planning module shell. Real content arrives with the planning
// core phases (TP-4+); this placeholder keeps the module lazily loaded so
// its eventual weight never lands in the research bundle.
export default function PlanningModule() {
  return (
    <div className="h-full overflow-y-auto p-8">
      <h1 className="font-display text-3xl mb-2">Planning</h1>
      <p className="text-ink/60 max-w-xl">
        Strategy plans — intake, scenarios, and deliverables — arrive in an upcoming release. Client
        records and research archival are available under Clients.
      </p>
    </div>
  );
}

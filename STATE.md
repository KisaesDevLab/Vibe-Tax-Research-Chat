# STATE — Planning Module build (MASTER-BUILD-PLAN.md)

Full build: slice 1 (TP-0…TP-3 + TP-11) then the remainder (TP-4…TP-10, TP-12…TP-16).
Updated after each phase commit.

| Phase | Title                                        | Status | Commit      |
| ----- | -------------------------------------------- | ------ | ----------- |
| TP-0  | Repo intake + `planning` flag scaffold       | done   | feat(tp-0)  |
| TP-1  | Module shell (Research / Planning / Clients) | done   | feat(tp-1)  |
| TP-2  | Shared client context                        | done   | feat(tp-2)  |
| TP-3  | Clients module (local-only)                  | done   | feat(tp-3)  |
| TP-11 | Chat archival to client                      | done   | feat(tp-11) |
| TP-4  | Tax engine + table sets                      | done   | feat(tp-4)  |
| TP-5  | Scenario + strategy runtime                  | done   | feat(tp-5)  |
| TP-6  | First 10 strategies + Planning UI            | done   | feat(tp-6)  |
| TP-7  | Intake (manual + PDF import)                 | done   | feat(tp-7)  |
| TP-8  | Plan workflow + review gate                  | done   | feat(tp-8)  |
| TP-9  | Deliverables + delivery                      | done   | feat(tp-9)  |
| TP-10 | Engagement loop                              | done   | feat(tp-10) |
| TP-12 | Authoring at scale (100 strategies)          | done   | feat(tp-12) |
| TP-13 | Claude seam upgrade                          | done   | feat(tp-13) |
| TP-14 | Currency jobs                                | done   | feat(tp-14) |
| TP-15 | Hardening + restore drill                    | done   | feat(tp-15) |
| TP-16 | Rollout + final verification                 | done   | feat(tp-16) |

## Notes

- `reference/strategy-library/` intake verified: 101 markdown files, gitignored + dockerignored.
- Applied defaults are logged in QUESTIONS.md (planning-module sections).
- TABLES_2026 seed figures verified via web research 2026-07 (Rev. Proc. 2025-32, SSA
  wage base, Notice 2025-67, OBBBA parameters) with per-group sourceNotes.
- Engine: 53 checkpoint tests green; ENGINE_VERSION 1.0.0.
- TP-12 done bar met: 100/100 records schema-valid with suggest rules; 56/56 modeled with
  registered apply modules and 112 engine-computed goldens; seed idempotent (double-seed
  inserts 0); planning API serves 100/56.
- TP-15 restore drill (local mode): backup.sh BACKUP_MODE=local against pg:5439 →
  restore into scratch DB → verified 100 strategies / 112 goldens / 57 audit rows and
  both 0012 triggers survive and raise. Procedure: scripts/backup.sh + gunzip|psql,
  see docs/deployment-checklist.md §4.
- TP-16 fresh-DB verification walk passed end-to-end (migrate 0000–0012, double-seed
  idempotency, intake → compute matching goldens, gate blocked→linked→passed, presented
  freeze 409 + DB trigger, Chromium advisor PDF, signed-link download, 402 fail-closed →
  entitled client PDF, signed OpenSign/Stripe fixtures auto-advancing to engaged with
  name reveal, no-key job skips). Operator guide: docs/planning-module.md.
- Build complete: TP-0…TP-16 all done.

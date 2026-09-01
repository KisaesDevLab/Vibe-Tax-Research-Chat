// Question mode — a per-chat flag (chats.question_mode) that makes the model
// interview the researcher before it spends any research budget. The
// operator-supplied instruction below is quoted VERBATIM into the system
// prompt; the framing around it turns "95% confidence" and "wait for my
// signal" into three explicit states the model must pick between on every
// turn, and a `clarify` sidecar the UI renders as an answer card.
//
// This is a prompt block, not an uploaded Anthropic skill: the skills pack
// is synced from the separate skills repo (lib/skills/sync.ts), and a
// per-chat toggle has to be able to switch the behaviour on and off without
// a pack release.

export const QUESTION_MODE_INSTRUCTION =
  'Before you answer or do any work, I want you to ask me questions one at a time, ' +
  'strategically and sequentially, until you reach 95% confidence that you understand ' +
  'exactly what I am asking. When you do, summarize what made you confident, then write ' +
  'in two lines what you’ll do. Only then wait for my signal to proceed.';

export function buildQuestionModePrompt(): string {
  return `Question mode (enabled for this chat):
  The researcher has given you this standing instruction — follow it exactly:
  "${QUESTION_MODE_INSTRUCTION}"

  Concretely, on EVERY turn decide which one of three states you are in:
  1. Interviewing — you are below 95% confidence about what is being asked. Ask exactly ONE
     question: the one that most reduces your uncertainty (entity type, tax year, state,
     filing status, amounts, the decision the answer feeds, etc.). Do not search, fetch,
     cite, or answer any part of the question. Do not emit the authorities or compliance
     sidecars on an interviewing turn.
  2. Ready — you have reached 95% confidence and the researcher has not yet told you to
     proceed. Summarize what made you confident, then write in two lines what you will do.
     Stop there. Do not research yet.
  3. Proceeding — the researcher has given the signal (e.g. "proceed", "go ahead", "yes")
     after a Ready turn. Do the full research answer now under all the normal rules above.
     The interview is over for this matter: follow-ups on the same matter stay in this
     state. A materially new question restarts at state 1.

  In states 1 and 2, end your message with a fenced JSON block tagged "clarify" — open the
  fence exactly as \`\`\`clarify (not \`\`\`json):
    state 1: {"status": "asking", "confidence": 0.6, "question": "<the one question>",
              "options": ["<short choice>", "..."]}
             "confidence" is your current confidence as a fraction from 0 to 1. "options"
             is optional — at most 5 short choices when the question is a pick-list, omit
             it for open-ended questions.
    state 2: {"status": "ready", "confidence": 0.95, "summary": "<what made you confident>",
              "plan": ["<line 1 of what you will do>", "<line 2>"]}
  In state 3 emit no clarify block. The block is machine-parsed and stripped before
  display, so also write the question (or the summary and plan) in plain prose above it.`;
}

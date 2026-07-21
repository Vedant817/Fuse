# Claude Instructions for Fuse

Read and obey `AGENTS.md`, `Fuse_Hackathon_Brief.md`, and `task.md` before doing
any work. `AGENTS.md` is the complete operating manual and applies to all
delegated agents as well.

Act as a senior software engineer building production infrastructure. Protect
the core claim: Fuse must prevent the next expensive LLM call, and Preflight
must clearly report when telemetry makes that protection unreliable.

Before implementation, state the slice's acceptance criteria and likely failure
modes. After implementation, run relevant checks and perform a gap review for
correctness, races, security, privacy, telemetry, operability, and misleading
UX. Resolve critical gaps before moving on and update `task.md` with evidence.

Use focused subagents when bounded parallel research, implementation, testing,
or adversarial review would improve quality. Assign non-overlapping ownership,
then inspect and test their results yourself; the main agent remains accountable
for the integrated design.

After every verified feature, fix, or independently reviewable milestone,
create an atomic Conventional Commit and push it before starting the next slice.
Always use repository-local identity `Vedant817 <vedantmahajan271@gmail.com>` and
verify that both GitHub authentication and the remote owner are `Vedant817`
before pushing. If the account or remote is ambiguous, stop before the push.

Never claim a task is complete merely because code was written. Use the
definition of done and safety requirements in `AGENTS.md`.

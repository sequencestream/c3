# From Requirement to Intent

In the era of AI software engineering, the unit that expresses "what we are going to build" is shifting from the requirement to the intent. This document first explains that shift, then introduces the concrete shape and usage of intents in c3.

---

## Part 1: From requirement to intent

### Background: the problems with traditional requirements

Traditional software engineering starts from requirements: a product manager writes a document, developers read it, split it into tasks, and write code. This process ran for decades in the era where humans wrote the code, but it has several problems:

1. **It states the "what" and loses the "why".** Requirement documents tend to be feature lists ("add an export button"), while the context — why we are doing it, which alternatives were weighed — stays in meeting rooms and chat logs. Developers receive conclusions rather than intent, so when they hit an edge case they can only guess or keep asking.
2. **Decomposition is manual, and freezes once done.** Requirements are broken down by hand through "epic → feature → user story → task", then frozen in a ticket system where they evolve separately from code, tests, and docs. Over time, "what the ticket says" and "what the code does" drift apart.
3. **Fuzzy completion criteria, manual acceptance.** Many requirements have no verifiable completion criteria; acceptance depends on the tester's experience. Tests and docs are often split into separate tasks, which get cut when the schedule tightens.
4. **A gap of human effort sits between requirement and execution.** No matter how well a requirement is written, a human still has to understand it and translate it into code — that is both a cost and the main source of distortion.

These problems were tolerable friction when humans wrote the code — a human had to digest the requirement anyway. But once AI agents become the executors, the system is no longer sufficient.

### What an intent is

An AI agent can start from a piece of natural language and go read code, plan an approach, modify files, and run tests. Execution is no longer the bottleneck; the bottleneck becomes whether "what you actually want" can be expressed precisely, completely, and verifiably.

That is why the intent enters the picture. An intent is not a requirement under a new name — it is an expression unit designed for the division of labour where "AI executes, humans gate". A requirement targets humans, who fill in the context, split the tasks, and judge completion. An intent targets agents, so it must carry its own context (Why), boundary (What / Non-goals), trade-offs, and verifiable completion criteria (Acceptance) — because the agent executing it has nothing but the text you gave it.

The way an intent comes into being is different too: instead of a human writing a document alone, it is co-created in dialogue between human and AI — you state an idea, the AI helps clarify, complete, and split it into a set of right-sized intent items with clear dependencies, and it only takes effect once you confirm.

### The five dimensions of intent content

At the core of intent content are five dimensions: Why, What, Trade-offs, When, Acceptance. This is the minimum complete information set that lets an agent execute the intent correctly and lets a human accept it reliably — When may be omitted when there is no external timing constraint, but if any other dimension is missing, execution comes down to guesswork.

The same example runs through the explanation below: "add CSV export to the user list".

#### Why — why we are doing it

The question it answers: what problem does this intent solve? What happens if we do not do it?

Why is the part most often lost in traditional requirements, yet it is the most important basis for an agent's technical decisions. For the same "export CSV", if the Why is "operations manually assembles user data into a report every week", the agent will lean toward columns and formats that match reporting habits; if the Why is "data retention for compliance audits", then completeness and field fidelity outweigh readability. Why sets the direction for countless trade-offs made during implementation.

> ❌ Add an export feature. (No Why — any disagreement can only be guessed at.)
>
> ✅ The operations team needs to import the user list into Excel every week for growth analysis. Today they copy and paste by hand, which frequently goes wrong at 300+ rows and takes about an hour.

#### What — what we build, and where the boundary is

The question it answers: what capability is delivered? How far does the scope go? What is explicitly out of scope (Non-goals)?

What describes observable behaviour changes, not implementation details (no file paths, no function names — that is the agent's job). The boundary matters just as much: stating explicitly what is not being done prevents scope creep and misaligned expectations at acceptance.

> ✅ Add an "Export CSV" button to the user list page. It exports all users matching the current filters (not just the current page), with four columns: name, email, registration time, status. Not doing: Excel (.xlsx) format, scheduled automatic exports, export history.

#### Trade-offs — what was weighed and given up

The question it answers: what alternatives existed? Why this one and not those? What cost did we accept?

Traditional requirements only give the conclusion; the weighing stays in the meeting room. Later maintainers who see a "strange" design have no way to tell whether it was carefully considered or historical baggage. Write the trade-offs into the intent, and when the agent reaches a related fork it can follow the established direction instead of reinventing an approach that contradicts your decision.

> ✅ For large exports we considered a background async job plus email notification, but at the current user scale (<50k rows) synchronous streaming export is enough and avoids the complexity of a task queue. The accepted cost is a longer request duration for very large filter results, with a 60-second timeout ceiling.

#### When — external timing

The question it answers: are there external time constraints or trigger conditions? For example a deadline, a release window, or external state that must be ready first.

When records external timing only: trigger conditions, deadlines, external prerequisites depended upon. It is the only one of the five dimensions that may be omitted — there is no need to force it when no external timing constraint exists.

> ✅ The operations team's monthly growth report is generated on the 1st of each month, so the export feature needs to ship before the end of this month. The externally visible naming of the "status" column can only be finalized once operations confirms the enum values.

#### Acceptance — verifiable completion criteria

The question it answers: what observable conditions must hold for this to count as "done"?

Acceptance is the most critical dimension for the "AI executes, humans gate" split. It must be a verifiable behaviour checklist rather than vague phrasing like "the feature works" — the development agent uses it to self-check, an independent completion judgement refers to it, and you can accept the work by ticking items off without reading code. Following the "one goal, one intent" principle, keeping the companion tests and docs in sync is written here too.

> ✅ Example:
>
> - After applying any filter on the user list page and clicking export, the downloaded CSV has the same number of rows as the total filter result;
> - The CSV is encoded as UTF-8 with BOM, so Chinese text opens correctly in Excel without mojibake;
> - Exporting an empty result yields a header-only file rather than an error;
> - The export endpoint has integration tests covering the three cases above;
> - The "list operations" section of the user manual documents the export.

#### The five dimensions in summary

| Dimension      | Question it answers                 | Consequence if missing                                                |
| -------------- | ----------------------------------- | --------------------------------------------------------------------- |
| **Why**        | Why we are doing it                 | The agent guesses blindly at every trade-off fork                     |
| **What**       | What we do and do not do            | Scope creep, or delivering the wrong thing                            |
| **Trade-offs** | Why we do it this way               | Rejected alternatives get reinvented                                  |
| **When**       | Which external timing constrains it | Missed deadlines, or wasted work before external conditions are ready |
| **Acceptance** | What counts as done                 | Completion cannot be judged; acceptance means a human reading code    |

> Tip: you do not need to write all five dimensions upfront — state your idea in a sentence or two, and the AI will ask questions grounded in the project code, fill in the gaps, and finally produce an intent covering all five dimensions for you to confirm.

### Characteristics of an intent

- **Self-contained context, independently executable.** The agent needs no off-stage information to start, and whoever accepts the work needs no code reading to judge it.
- **Right-sized.** Split to a size that can be completed and verified in one go — neither a big vague epic nor a pile of fragmentary subtasks.
- **One goal is one intent.** Code, companion tests, and companion docs fold into the same intent, never split into separate "add tests" / "update docs" tickets — this structurally prevents the three from falling out of sync.
- **Verifiable completion criteria.** Acceptance describes observable behaviour, so completion can be judged independently from the conclusion and the code changes once development ends.

### Benefits of moving from requirements to intents

1. **Express once, reuse throughout.** An intent's context serves you (who confirm it), the agent writing the spec, and the agent implementing it — no repeated verbal briefings.
2. **Human effort goes where it matters.** People no longer write code line by line; they gate at the key checkpoints: confirming intents, approving approaches, approving sensitive operations, accepting results.
3. **Traceable and auditable.** Every intent is linked to its communication record, spec document, development session, code branch, and PR/MR — the whole chain is on the record.
4. **Naturally supports parallelism and automation.** A dependency graph plus worktree isolation lets multiple intents be developed in parallel without interfering; and it is the built-in completion criteria that make the "develop autonomously → judge completion → commit → next" automation loop possible at all.
5. **Code, tests, and docs stop drifting.** "One goal, one intent" guarantees at the source that all three are implemented and accepted as a whole.
6. **Less translation loss.** An intent is clarified jointly by human and AI in the context of the project code, making it more complete and less ambiguous than a requirement document written from memory.

---

## Part 2: Intents in c3 and how to use them

c3 drives coding work through intents: requirements, specs, tests, and docs fold into the same goal, realizing the "one goal, one intent" principle. See https://github.com/sequencestream/c3 for details.

### What makes up an intent in c3

In c3, an intent lands as one structured workspace-scoped record with the following main fields:

- **title** — one sentence stating what this intent is meant to achieve
- **shortEnTitle** — a short ASCII title, used to derive the Git branch name / worktree directory name
- **content** — the full description covering the five dimensions from Part 1: **Why / What / Trade-offs / When / Acceptance**. Draft and todo items can be edited in place; once work is in progress the body is locked
- **priority** — `P0`–`P3`, with P0 highest; determines queue order
- **impactLevel** — `L1`–`L5`, orthogonal to priority: priority answers when to do it, impact answers how far a mistake reaches. High impact forces spec-first and forbids machine approval; low impact defaults to `fast` unless explicitly overridden
- **specMode** — `sdd` (must approve a spec first) / `fast` (may start work first; over-threshold diffs reverse-fill a spec) / empty (inherit the workspace). Locked once spec or development has started
- **module** — inferred by the communication agent from the title/content; display only
- **status** — `draft` → `todo` → `in_progress` → `reviewing` → `done` / `cancelled`. `reviewing` means code is committed and the PR is not yet settled
- **dependencies** — directed edges in the same workspace. The gate asks whether the predecessor's output is already on this intent's baseline, not whether the predecessor PR is merged; a manual start may waive the dependency gate once
- **automate** — whether this intent is a candidate for the workspace intent queue; the flag grants candidacy only, it does not start the queue or skip gates
- **base branch** — a snapshot written at creation time, not chasing later mainline movement. PR targets and worktree baselines read the same value

An intent may also carry communication sessions, spec-writing / spec-review sessions, a work session, PR rows, WorkNotes, and deliveries.

### Prerequisites

You have completed the installation and startup in the [c3 Getting Started Guide](c3-get-start.md), and created a workspace pointing at your project directory.

### Creating an intent, option 1: create directly (the main entry)

1. **Enter the intent view and click +.** The create-intent dialog opens.
2. **Pick a base.** Two mutually exclusive choices: a workspace branch (prefilled with the main branch) or a still-writable delivery (branch ready, and still in planned / integrating).
3. **Write the idea.** Content must be non-empty to submit. In one request the server registers the intent, records the base, and starts that intent's communication session with this text as the first turn — you do not open a second session to restate the background. Empty content only registers; it does not start a session.
4. **Let the communication agent refine it.** The agent is read-only: it can read project code, search the web, and query existing intents in this workspace, and it can ask you clarifying questions, but it cannot modify files or run commands. It turns the idea into right-sized items covering the five dimensions, annotated with priority, impact, module, and dependencies.
5. **Confirm in the conversation before anything is stored.** The agent must list every intent in the turn and obtain your explicit textual confirmation, then call save. The call writes immediately — no permission panel; a validation failure writes nothing. Newly saved items start as `todo`. Without your confirmation, nothing lands through this path.

### Creating an intent, option 2: convert from a multi-agent discussion

When the direction is still unclear, start a [discussion](discussion.md) first. When it has completed with a non-empty conclusion, click Convert to Intent; the conclusion enters the same creation primitive and still lands only after communication and confirmation.

### After creation: from intent to development

Once an intent is stored, the typical path forward is:

```
intent (todo)
   → [when the effective mode requires a spec] Write Spec → read-only review → approve (human, or machine if the workspace opted in)
   → Start Work (attach or resume if a session exists, otherwise create; worktree isolation is the default)
   → commit / push / create PR (optionally onto a delivery) → review / fix → mark done
```

- **Refine:** a saved intent can be opened in a communication session to keep polishing it; an id updates in place instead of duplicating. A real change to title or body revokes spec approval.
- **Spec:** the workspace SDD switch is on by default; each intent can override with `specMode`. See [SDD](sdd.md).
- **Dependencies:** unmet ones warn in the list; the real gate is whether predecessor output is on this baseline. The queue does not offer a one-shot waiver.
- **Queue:** mark `automate` and start this workspace's intent queue; c3 picks by priority then earliest created, can autonomously write / review specs with bounded rework, and on development failure backs off then parks after three consecutive failures. A permission wait that times out parks and files a todo — it never answers for you. This scheduler is not the cron / event automations on the [Automations](automation-engineering.md) page.
- **Delivery:** intent PRs can land on a delivery branch so a batch is verified before the mainline. See [Delivery](delivery.md).

> Tip: on your first attempt, pick a small, clear idea (say "add a validation to some module") and walk the full "create → confirm → start work" flow to feel the difference between an intent and simply typing a prompt into a session.

### FAQ

**Q: What is the difference between an intent and just typing a prompt into a session?**

A: A session prompt is one-off — when the conversation ends, the context disperses. An intent is a durable structured record that can be refined, depended upon, scheduled, and queued, and it links to the full development and delivery chain. Chat directly for small things; use intents for serious feature evolution.

**Q: Could the intent communication agent secretly modify my code?**

A: No. Its read-only constraint is enforced at the tool layer (not by prompt discipline): editing, writing files, running commands, spawning subagents, and slash commands are hard-disabled.

**Q: Could an intent be saved without my consent?**

A: Not on the communication path. Save requires your explicit confirmation in the conversation; the call then writes immediately and does not go through Allow/Deny. If an administrator has granted write tools to an external MCP key or a chat robot, that grant replaces conversational confirmation — business validation is not relaxed.

**Q: Should one big idea become one intent or several?**

A: Let the communication agent split it — it produces multiple right-sized intents with explicit dependencies, and items saved in the same batch can declare ordering dependencies between each other. The principle is: one independently completable, independently verifiable goal is one intent; the code, tests, and docs for the same goal always live in the same intent.

## References

- [c3 Getting Started Guide](c3-get-start.md)
- [Spec-Driven Development (SDD)](sdd.md)
- [Delivery](delivery.md)

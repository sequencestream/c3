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

c3 (Code Creative Center) is a coding platform that fuses harness design, loop engineering, and AI software engineering practices. It drives coding work through intents, treating requirements, specs, tests, and docs as subtasks of an intent, realizing the "one goal, one intent" principle. See https://github.com/sequencestream/c3 for details.

### What makes up an intent in c3

In c3, an intent lands as one structured project-level record with the following main fields:

| Component        | Description                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **title**        | One sentence stating what this intent is meant to achieve                                                                         |
| **shortEnTitle** | A short ASCII title, used to derive the Git branch name / worktree directory name                                                 |
| **content**      | The full description of the intent, covering the five dimensions from Part 1: **Why / What / Trade-offs / When / Acceptance**     |
| **priority**     | `P0`–`P3`, with P0 highest; determines execution order in automated development                                                   |
| **module**       | The module the intent belongs to, inferred by the communication agent from the title/content                                      |
| **status**       | The `draft` → `todo` → `in_progress` → `done` / `cancelled` state machine                                                         |
| **dependsOn**    | Other intents in the same project that this one depends on, forming a directed dependency graph that determines development order |
| **automate**     | Whether the automation orchestrator may develop this intent autonomously; off by default                                          |

### Prerequisites

You have completed the installation and startup in the [c3 Getting Started Guide](c3-get-start.md), and created a workspace pointing at your project directory.

### Creating an intent, option 1: talk to the intent communication agent (recommended)

1. **Enter the intent view.** In the workspace UI, click the + (create intent) button and c3 opens the intent communication session for that project.
2. **State your idea.** Describe what you want to do in natural language, for example:

   > I want to add an export feature to the user list, exporting to CSV, and it should handle large data volumes.

3. **Let the agent refine it with you.** The intent communication agent is read-only — it can read project code, search the web, and query existing intents in the project (to avoid duplication and reference dependencies correctly), and it can use a question tool to clarify things with you, but it can never modify files or run commands. Over several turns it turns your idea into one or more right-sized intent items, each covering the five dimensions, annotated with priority, module, and the dependencies between items.
4. **Confirm to save.** When the agent saves intents, c3 opens a confirmation panel listing every pending intent (including dependencies). Only after you click Allow are the intents written with `todo` status; clicking Deny writes nothing. Without your confirmation, no intent ever reaches the store.

### Creating an intent, option 2: convert from a multi-agent discussion

For questions where the direction is still unclear, start a discussion first: several AI agents hold a round-table on your goal and converge on a conclusion. When the discussion finishes, click Convert to Intent and the conclusion feeds into the same intent refinement flow, again landing in the store only after your confirmation.

### After creation: from intent to development

Once an intent is stored, the typical path forward is:

```
intent (todo) → [optional] Write Spec → [optional] Approve Spec
    → Start Work (background session, optional worktree isolation)
    → development finishes → commit / push / create PR → mark done
```

- **Refine:** a saved intent can be reopened in a communication session at any time to keep polishing it; updates overwrite the original item instead of producing duplicates.
- **Spec-driven (SDD):** once the workspace's SDD switch is on, an intent must first produce a spec document and receive human approval before it can enter development — that is the quality gate.
- **Automation:** mark an intent with `automate` and start the automation orchestrator, and c3 will develop, judge, commit, and push intents one by one following priority and dependency order.

> Tip: on your first attempt, pick a small, clear idea (say "add a validation to some module") and walk the full "dialogue → confirm → start work" flow to feel the difference between an intent and simply typing a prompt into a session.

### FAQ

**Q: What is the difference between an intent and just typing a prompt into a session?**

A: A session prompt is one-off — when the conversation ends, the context disperses. An intent is a durable structured record that can be refined, depended upon, scheduled, and automated, and it links to the full development chain. Chat directly for small things; use intents for serious feature evolution.

**Q: Could the intent communication agent secretly modify my code?**

A: No. Its read-only constraint is enforced at the tool layer (not by prompt discipline): editing, writing files, running commands, spawning subagents, and similar capabilities are hard-disabled.

**Q: Could an intent be saved without my consent?**

A: No. The save confirmation is enforced by the save handler itself — even under permission modes where tools are pre-approved, the confirmation panel still appears, and denying writes nothing.

**Q: Should one big idea become one intent or several?**

A: Let the communication agent split it — it produces multiple right-sized intents with explicit dependencies, and items saved in the same batch can declare ordering dependencies between each other. The principle is: one independently completable, independently verifiable goal is one intent; the code, tests, and docs for the same goal always live in the same intent.

## References

- [c3 Getting Started Guide](c3-get-start.md)

# From Meetings to Agent Discussions

In the era of AI software engineering, "pull a group of people into a meeting room and hash out a conclusion" is evolving into letting a group of AI agents hold a round-table on your goal. This document first covers that shift, then introduces the concrete shape and usage of discussions in c3.

---

## Part 1: From traditional meetings to agent discussions

### Background: the cost and problems of traditional meetings

The classic way for a software team to tackle a question with an unclear direction is a meeting: brainstorming, design review, technology selection, retrospectives. There is nothing wrong with meetings as such, but in practice a set of chronic problems has accumulated:

1. **High organizational cost, quality left to luck.** Getting the right people together means coordinating calendars, and a meeting often waits days; those who show up may not have done their homework, and if the required domain knowledge is not in the attendees' heads, the meeting produces no result.
2. **Unequal airtime.** The senior, the loud, and the first to speak have a natural advantage, while thoughtful but slower speakers often never finish their point — and the final "consensus" is frequently just "nobody objected any further".
3. **The process is lost, the conclusion is fuzzy.** Most meetings have no complete record. Which options were rejected, why, and what premises the conclusion rests on — weeks later nobody can say.
4. **Discussion is disconnected from execution.** The conclusion sits in the minutes and still needs someone to translate it into requirements, split it into tasks, and fit it into a plan; whoever executes usually receives only a one-line conclusion with no backstory.
5. **The team composition has already changed.** "Holding a meeting" assumes a group of people behind the project, but more and more projects are driven by one human engineer with a team of agents. In that composition you cannot invite agents into the meeting room, nor should the single human speak on behalf of every agent — what is needed is a new form where human and agent, and agent and agent, can deliberate as equals.

Once AI agents gained the ability to read code, search for material, and express independent views, discussion took on a new form.

### What an agent discussion is

An agent discussion has multiple AI agents hold a multi-round round-table on the goal you set, organized by an "organizer agent", converging on a structured conclusion. It deliberately brings in several independent perspectives:

- **Every participant answers independently.** The same question goes to multiple agents in parallel, each speaking independently based on the same discussion record.
- **The organizer handles organization and convergence.** It splits sub-topics, advances them one by one, synthesizes views, confirms with each party, and writes down the conclusion.
- **Homework comes before the discussion.** A read-only research agent first reads code and searches for material, compiling facts, current state, and constraints, so all participants enter with the same background.
- **A human can step in at any time.** You can observe, pause, interject, and follow up, but you do not have to be present throughout — the record and the conclusion are there when the run finishes.
- **The conclusion goes straight to execution.** A discussion conclusion can be converted into an intent with one click, entering the "confirm → develop → accept" flow.

### Good fits

Agent discussions suit questions where the direction is still unclear and multiple perspectives need to collide, matching the five discussion types built into c3:

| Scenario                 | Discussion type | Typical question                                                                                                                           |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Brainstorming**        | Brainstorm      | "What are the feasible evolution directions for the caching layer?" — diverge broadly to generate ideas, then converge on the valuable few |
| **Deciding an approach** | Decision        | "Kafka or NATS for the message queue?" — compare candidates against criteria, pick one, and explain why                                    |
| **Review and gating**    | Review          | "What is wrong with this API design draft?" — examine a proposal from multiple angles, exposing risks and open items                       |
| **Planning breakdown**   | Planning        | "How should we sequence next quarter's refactor?" — break a big goal into an ordered execution plan                                        |
| **Retrospective**        | Retro           | "What did this production incident expose?" — sort out what happened, why, and what changes next time                                      |

Conversely, work whose goal is already clear and only needs implementing does not need a discussion — just create an intent or start working in a session. If you can state "what to build and what counts as done" in one sentence, skip the discussion; if what comes out of your mouth is "I'm not sure…" or "is there a better…", that is where discussions shine.

### Benefits of moving from meetings to agent discussions

1. **Zero coordination cost, start any time.** No scheduling, no waiting for people — the moment an idea appears you can start one and have a conclusion in minutes.
2. **Diverse and balanced perspectives.** Participants can be agents from different vendors with different configurations, each speaking independently with equal opportunity.
3. **The whole process is on the record.** Who said what in each round, how topics advanced, how the conclusion was reached — all reviewable at any time.
4. **Humans gate at the key points.** You need not watch throughout; you can interject mid-way to correct course, or follow up and continue the run when the conclusion falls short.
5. **The conclusion plugs seamlessly into execution.** One click converts it into an intent, and the background, research, and trade-offs accumulated in the discussion travel with it into intent refinement.

---

## Part 2: Discussions in c3 and how to use them

c3 (Code Creative Center) provides multi-agent round-table deliberation through its Discussion feature, wired through to the intent system — discussions are for "thinking it through", intents are for "getting it built". See https://github.com/sequencestream/c3 for details.

### What makes up a discussion in c3

In c3, a discussion is a structured record within a workspace with the following main fields:

| Component           | Description                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **type**            | One of Brainstorm / Decision / Review / Planning / Retro, which determines how each phase is guided                                                         |
| **goal**            | The question this discussion must answer or the purpose it must achieve; the title is derived from it                                                       |
| **context**         | The background you provide, kept permanently as your original input and never overwritten                                                                   |
| **researchResult**  | The current-state research produced by the read-only research agent before the discussion starts, stored separately from the context                        |
| **researchSession** | The research run's own session. Research is not a one-shot call: the process stays viewable, and a follow-up after it finishes rewrites the research result |
| **organizer**       | The organizing agent designated at creation, responsible for running the discussion and writing the conclusion                                              |
| **participants**    | The set of agents selected at creation, which may mix models from different vendors                                                                         |
| **agenda**          | The ordered list of sub-topics the organizer derives from the goal; the discussion advances along it                                                        |
| **conclusion**      | The final output of the discussion, convertible into an intent                                                                                              |
| **status**          | The `draft` → `in_progress` → `completed` / `cancelled` state machine                                                                                       |

### The three roles in a discussion

- **Organizer**: every round is decided by the organizer — splitting the goal into an agenda, nominating who speaks, broadcasting the same question to multiple participants, summarizing, advancing phases, and finally writing the conclusion. The organizer always takes part in the discussion, and can complete one alone even if it is the only agent (degrading gracefully into "solo deep thinking").
- **Participant**: speaks independently when nominated or broadcast to, adding only new points and not repeating what others already said. The differences in perspective come from their different models and configurations.
- **Human**: you. You can pause, interject, and follow up at any time; your remarks enter the discussion record as a message, which the organizer reads in the next round and factors into its organization.

### Prerequisites

You have completed the installation and startup in the [c3 Getting Started Guide](c3-get-start.md), created a workspace pointing at your project directory, and enabled at least two agents (one as organizer, one as participant).

### Starting a discussion

1. **Enter the discussion view.** Switch to the Discussion tab in the top navigation of the c3 console; the left column lists the workspace's discussions.
2. **Click the + button at the top of the list**, and fill in the creation panel:
   - **Type**: pick whichever of Brainstorm / Decision / Review / Planning / Retro fits your question;
   - **Goal (required)**: one sentence stating what this discussion must answer, for example:

     > The existing scheduled task module frequently misses runs; let's discuss the root cause and the evolution direction.

   - **Context (optional)**: the background, constraints, and leanings you already know;
   - **Participants**: all enabled agents are selected by default; check a subset as needed;
   - **Organizer**: use the radio buttons to designate one of the agents.

3. **Submit.** Requirements: a non-empty goal, a designated organizer, and at least one participant other than the organizer. After submitting, the new discussion opens automatically in the right column.

### How a discussion proceeds

The full lifecycle of a discussion:

```
created (draft) → read-only research (survey the current state) → discussion starts automatically (in_progress)
    → discuss → summarize → confirm → conclude
    → completed → [optional] convert to intent / keep following up
```

- **Read-only research comes first.** After creation, c3 first dispatches a read-only research agent: it can read project code and search the web, but cannot modify files or run commands. Its output is strictly limited to facts, current state, constraints, and open questions — deliberately no approaches or recommendations, so a presupposed answer does not pollute the discussion that follows. On success the discussion starts automatically; on failure the draft is kept and you can click Start manually.
- **The research process is reviewable and correctable.** That research run is a real session: which files it read and what it searched for all stay in the 「Research session」 tab, and remain there long after the discussion is over. While the run is live the tab shows its run state and a working Stop; once it has finished you can keep asking there (e.g. "the caching part is too shallow — please also map out the invalidation strategy"), and c3 resumes the same session and replaces the 「Research」 tab's content with the new findings. A follow-up turn is just as read-only as the first one — still no file edits, still no commands.
- **Four phases, advancing one way only.** Whatever the discussion type, it goes through "discuss → summarize → confirm → conclude", with only the guidance prompts of each phase differing by type. Phases can only advance, never go back, which guarantees the discussion converges.
- **Diverge by broadcast, converge by nomination.** In the discuss phase the organizer splits the goal into ordered sub-topics and broadcasts the same sub-question to multiple participants in parallel for independent answers; everyone sees the same snapshot of the discussion record and does not interfere with the others. In the summarize and confirm phases it switches to nominating speakers one at a time, polishing serially.
- **It will definitely end.** Each phase has a round cap (12 rounds per phase by default, configurable per workspace) and the whole discussion has a hard total cap (40 rounds by default), so even a deadlocked discussion writes a fallback conclusion at the cap instead of burning money forever.

### The three ways a human intervenes

| Action             | When available            | Effect                                                                                                                                                                                       |
| ------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pause / Resume** | While the discussion runs | Suspends the discussion at a round boundary (the remark being generated finishes first), and resumes in place                                                                                |
| **Speak**          | While the discussion runs | Interject in the input box; your words enter the discussion record and the organizer reads them next round and adjusts direction                                                             |
| **Continue**       | Discussion completed      | When unsatisfied with the conclusion or you have follow-ups, enter a new question; the discussion returns to in progress, continues on top of the full record, and produces a new conclusion |

> Tip: you do not have to watch a discussion throughout. Start it, go do something else, and read the conclusion when you come back; if you feel it drifted, use "Continue" for one more round of follow-up — often less work than intervening mid-way.

### Reviewing the output and converting to an intent

The right column of the discussion detail presents tabs: goal, context, research, conclusion (Markdown-rendered), research session (the research run's full process — stoppable, and open to follow-ups), process session (the full record of remarks), and details. Every agent remark carries a vendor tag, so who said it and on which model is obvious at a glance. The research session is also listed on the sessions page under 「Discussion」, from where it jumps back to this discussion.

When the discussion is completed and the conclusion is non-empty, a Convert to Intent button appears in the title bar. Clicking it makes c3 open the project's intent communication session carrying the discussion title and conclusion, and the intent communication agent breaks the conclusion into one or more intent items covering the five dimensions Why / What / Trade-offs / When / Acceptance — exactly the same flow as creating an intent directly, and likewise nothing lands in the store until you click Allow in the confirmation panel. From there it joins the "intent → development" path described in [From Requirement to Intent](./requirement-to-intent.md).

### FAQ

**Q: What is the difference between a discussion and just asking one agent?**

A: A single agent gives you an answer from one perspective; a discussion deliberately organizes multiple independent agents to research first, then speak separately, with an organizer synthesizing and confirming, so views collide and converge and the whole process is on the record. Ask directly for small questions with a clear direction; use a discussion for big questions where the direction is uncertain.

**Q: Will the agents in a discussion modify my code?**

A: No. A discussion only ever reads and speaks: the research agent is read-only as enforced at the tool layer (cannot write files, run commands, or spawn subagents), while each round of remarks from the organizer and participants is a one-shot Q&A with all tools disabled.

**Q: Could a discussion run forever without stopping?**

A: No. Phases can only advance one way, and both each phase and the whole discussion have round caps; hitting a cap automatically writes a fallback conclusion. You can also pause at any time.

**Q: What if I am not satisfied with the conclusion?**

A: Use Continue to enter your follow-up or correction, and the discussion continues on top of the full record, producing a new conclusion that supersedes the old one. You can also speak up at any time while the discussion is running to pull the direction back early.

**Q: How many participants is a good number?**

A: Two to four is usually enough — more participants bring richer perspectives but also more rounds and cost. For approach-decision questions, prefer agents with different configurations or vendors, so the perspectives differ more.

## References

- [c3 Getting Started Guide](c3-get-start.md)
- [From Requirement to Intent](requirement-to-intent.md)
- [Spec-Driven Development (SDD)](sdd.md)

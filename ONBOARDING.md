# Welcome to Claude Code Center (c3)

## How We Use Claude

Based on tiltwind's usage over the last 30 days:

Work Type Breakdown:
Build Feature ████████████████████ 34%
Improve Quality ████████████████████ 34%
Debug Fix ████████████░░░░░░░░ 20%
Plan Design ████░░░░░░░░░░░░░░░░ 7%
Write Docs ███░░░░░░░░░░░░░░░░░ 5%

Top Skills & Commands:
/clear ████████████████████ 43x/month
/develop-pipeline ████░░░░░░░░░░░░░░░░ 9x/month
/sdd-lite ██░░░░░░░░░░░░░░░░░░ 4x/month
/project-spec █░░░░░░░░░░░░░░░░░░░ 1x/month
/init █░░░░░░░░░░░░░░░░░░░ 1x/month
/plan █░░░░░░░░░░░░░░░░░░░ 1x/month

Top MCP Servers:
c3 ████████████████████ 6 calls

## Your Setup Checklist

### Codebases

- [ ] claude-code-center — https://github.com/sequencestream/claude-code-center
- [ ] develop-pipeline — backs the `/develop-pipeline` skill (sibling repo in the workspace)
- [ ] sdd-lite — backs the `/sdd-lite` skill (sibling repo in the workspace)
- [ ] project-spec — backs the `/project-spec` skill (sibling repo in the workspace)

### MCP Servers to Activate

- [ ] c3 — the Claude Code Center server itself, exposing tool-use permission prompts over MCP so they can be answered in a browser instead of the terminal. Access: clone claude-code-center, `pnpm install`, then `pnpm dev` (server on :3000, web on :5173).

### Skills to Know About

- [ ] /develop-pipeline — team-based development pipeline; the main agent acts as team-lead and spawns seven persistent phase teammates (analyst, designer, improver, developer, reviewer, tester, documenter) over a shared task board. The team's go-to for building out a full feature.
- [ ] /sdd-lite — lightweight checkpoint-driven coding harness for high-frequency, multi-turn agentic work, keeping control through a minimal spec, restatements, and evidence-based validation.
- [ ] /project-spec — define and maintain the `specs/` documents (domains, ADRs, glossary, non-functional). Remember: in this repo, `specs/` is the source of truth and stays synchronized with code.
- [ ] /plan — design an implementation strategy before writing code.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->

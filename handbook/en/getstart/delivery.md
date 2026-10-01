# Delivery

A delivery is the integration unit: several intents land together, get verified, then enter the mainline through one delivery PR. An intent answers what one unit of work should become; a delivery answers which branch those units share, who verifies the batch, and when it goes to the mainline. c3 never merges to the mainline for you.

> Read [From Requirement to Intent](requirement-to-intent.md) first. Delivery is built on worktree mode: current-branch workspaces can still view and associate, but cannot initialize a delivery branch or create a delivery PR.

---

## 1. Why delivery exists

Several intents can develop in parallel, each with its own worktree and PR. If every PR targets the mainline, integration order, overwrites, and "can this batch ship together" live only in someone's head on the forge. A delivery turns the batch into one Git lifecycle unit:

- one delivery branch, so intent PRs land there instead of on the mainline;
- guards in order: branch ready → every associated intent PR merged → human verification → delivery PR merged to the mainline;
- associated intents cannot open new write sessions while verification is in progress, so the batch does not keep changing under you.

Skip delivery when the workspace has multiple repositories (the server refuses), when you only change the current checkout, or when each intent should merge to the mainline on its own.

---

## 2. How to use it in c3

### States

`planned` → `integrating` → `verifying` → `verified` → `delivered`. Non-terminal states can be cancelled. There is no separate "completed" — progress of associated PRs onto the delivery branch is shown as a live N/M.

### Prerequisites

- You have completed the [c3 Getting Started Guide](c3-get-start.md), and the workspace is in worktree mode;
- You have at least one intent, or you will pick this delivery as the base when creating one.

### Typical path

```
create a delivery (snapshot the current mainline as baseBranch)
   → initialize the delivery branch (fork from the remote mainline tip; bind if a same-named remote branch already starts at that tip)
   → associate intents (or one-click create a dedicated delivery from the intent)
   → intent PRs land on the delivery branch and merge
   → start verifying (the write window closes) → human confirms verification
   → create the delivery PR (delivery branch → mainline) → you merge it on the forge
   → mark delivered once the result is on the mainline
```

1. **Create.** Open the Delivery page from the header and create one. Creation snapshots the workspace mainline as the base; later setting changes do not rewrite it. Multi-repo workspaces cannot create a delivery.
2. **Initialize the branch.** Separate from creation. The baseline is the remote mainline tip, never a local ref. Being behind the mainline is only a warning. Terminal deliveries do not delete the remote branch; cleanup removes the local ref only.
3. **Associate intents.** Both the delivery page and the intent side can link. The association is an independent edge and does not retarget an existing PR. A PR already merged onto this delivery cannot be unlinked; unlinking an unmerged PR requires closing it first. The intent side can create a dedicated delivery, associate, and initialize the branch in one gesture; a failed step stops there and keeps what already succeeded.
4. **Integrate.** Integration requires a ready branch. While integrating you can merge the mainline into the delivery branch; conflicts abort, are not pushed, and are not resolved for you.
5. **Verify.** Verification requires at least one associated intent whose PRs onto this delivery are all merged. New write sessions are refused. A human confirmation moves it to verified.
6. **Delivery PR.** When verified, the branch is ready, and it differs from the mainline, create a PR to the mainline. c3 does not merge it and does not close leftover PRs. If the forge has merged but the local ledger has not confirmed, the page shows waiting; opening the page or a manual sync settles it. Already on the mainline marks delivered. A merge conflict rolls back to verifying.

The header badge counts only deliveries that need a person (an actionable gap, a transition you can take, or a delivery-PR action). Pure waiting and terminal states do not count.

### Relation to intents and automations

- Creating an intent can pick a still-writable delivery as its base (planned / integrating, branch ready).
- Lifecycle events (`delivery:created` and so on) can be subscribed to by automations; automations and external callers only get read-only `find` / `view`, with no write tools.

### FAQ

**Q: How is a delivery different from an intent PR?**

A: An intent PR is how one intent's code enters the delivery branch. A delivery PR is how the verified batch enters the mainline. The mainline is reached only through the delivery PR, and you merge it on the forge.

**Q: Can I use delivery in current-branch mode?**

A: You can create, view, edit, cancel, associate, and watch progress. You cannot initialize a branch or create a delivery PR.

**Q: Can I still change code after verification starts?**

A: Deliveries in verifying or a terminal state do not open new write sessions; an already-running attach is unaffected. To change code, send it back to integrating.

## References

- [c3 Getting Started Guide](c3-get-start.md)
- [From Requirement to Intent](requirement-to-intent.md)
- [Spec-Driven Development (SDD)](sdd.md)

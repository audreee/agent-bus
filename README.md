# agent-bus

A cross-session message bus for Copilot CLI. Lets a **coding agent** and a **review agent**
running in two separate interactive sessions hand work back and forth without you
copy-pasting between terminals.

```
 coder session                                    reviewer session
 ─────────────                                    ────────────────
 git push  ──[onPostToolUse]──┐
                              ▼
                    ~/.copilot/agent-bus/<topic>.jsonl
                              │
                              └──[fs.watch]──► session.send("review PR #42")
                                                        │
                                                        ▼
                                                  reviews the diff
                                                        │
 addresses comments ◄──[fs.watch]──┬──────── bus_publish(review_submitted)
                                   │
                    ~/.copilot/agent-bus/<topic>.jsonl
```

## Why an extension and not a plugin

Plugins can ship skills, agents, hooks, MCP and LSP configs — but **not extensions**, and
plugin hooks are purely *reactive*: `preToolUse`, `postToolUse`, `agentStop` and
`notification` all require the agent to already be doing something. There is no hook that
fires on "a file changed on disk".

The review agent spends most of its life **idle**, waiting for a push. Waking an idle
session requires a resident process calling `session.send()`, and only an extension can be
one. That is the whole reason this is an extension.

## Install

```bash
git clone https://github.com/audreee/agent-bus.git
cd agent-bus
script/install
```

`script/install` symlinks `extension.mjs` into `~/.copilot/extensions/agent-bus/` and
`statusline.mjs` into `~/.copilot/agent-bus/`, so a later `git pull` updates the running
extension with no second copy to keep in sync. Anything already at those paths is moved aside
rather than overwritten. Restart the CLI (or run `extensions_reload`) to pick it up.

Requires Node 18+ and a `gh` you're already logged into. `gh` is only needed for the PR
polling backstop and for resolving head SHAs; the local half of the bus works without it.

To scope the extension to a single repo instead, symlink it to
`<repo>/.github/extensions/agent-bus/extension.mjs`.

> **Scope matters for `-p`.** User-scoped extensions (`~/.copilot/extensions/`) load under
> `copilot -p`; project-scoped ones (`.github/extensions/`) do not. Keep this user-scoped if
> you want the bus tools available to scripted runs.

## It does nothing until you give a session a role

With no role resolved, the extension registers no tools and installs no hooks. This matters
because a user-scoped extension loads into *every* session you have open.

Roles resolve in this order:

1. `COPILOT_BUS_ROLE` environment variable
2. a runtime claim made by `bus_join`, persisted in `~/.copilot/agent-bus/sessions.json`
   keyed by session ID
3. `workspaces[<cwd>].role` in `~/.copilot/agent-bus/config.json` (longest path-prefix match,
   so subdirectories inherit their repo's entry)
4. no role → inert

The `bus_*` tools are always registered so that a fresh, unroled session can call `bus_join`;
every other tool refuses to act until a role exists, and no hooks fire without one.

## Usage

### Recommended: claim roles at runtime

You don't need to decide roles before launching. Open two sessions and just tell each one
what it is, in plain English:

```
Terminal A:  You're the coding agent for PR 42. Topic: pr-42, repo owner/myrepo.
Terminal B:  You're the reviewer for PR 42. Topic: pr-42, repo owner/myrepo.
```

Each agent calls `bus_join` itself. The claim is written to `sessions.json` under that
session's ID, so it survives an `extensions_reload` and a `--resume`. `bus_leave` releases it.

Keying on session ID (not cwd) means **both agents can run in the same directory** and stay
distinct — useful when you don't want a second worktree.

### Alternative: pre-assign by directory

If you always use the same two worktrees, pin the roles once and skip the prompt:

```jsonc
// ~/.copilot/agent-bus/config.json
{
  "workspaces": {
    "/Users/you/src/myrepo-code": {
      "role": "coder",
      "topic": "pr-42",
      "pr": 42,
      "repo": "owner/myrepo"
    },
    "/Users/you/src/myrepo-review": {
      "role": "reviewer",
      "topic": "pr-42",
      "pr": 42,
      "repo": "owner/myrepo"
    }
  }
}
```

Then open two terminals:

```bash
cd ~/src/myrepo-code   && copilot     # becomes the coder
cd ~/src/myrepo-review && copilot     # becomes the reviewer
```

Or by environment variable:

```bash
COPILOT_BUS_ROLE=coder    COPILOT_BUS_TOPIC=pr-42 copilot
COPILOT_BUS_ROLE=reviewer COPILOT_BUS_TOPIC=pr-42 copilot
```

Both sessions must share a `topic` — that's the channel. Use one topic per PR so
unrelated work doesn't cross-talk.

### Kicking off the loop

Tell the coder to do the work as usual. When it runs `git push` or `gh pr create`, the
reviewer wakes up on its own. From then on it runs unattended until the round cap, a
`bus_halt`, or you interrupt.

## Telling the sessions apart

Two identical-looking terminals is the main ergonomic hazard. Three ways to tell them apart,
strongest first:

**1. Statusline badge (persistent, always visible).** `script/install` puts the script in
place; register it once in `~/.copilot/settings.json`:

```json
"statusLine": { "type": "command", "command": "~/.copilot/agent-bus/statusline.mjs" }
```

Each session then shows its own badge below the input:

```
 🔍 REVIEWER  bus:pr-42 #42 12 msgs
 🔨 CODER     bus:pr-42 #42 12 msgs
```

The script reads the session's `session_id` and `cwd` from the status object on stdin and
resolves the role through the same order as the extension (env → `sessions.json` → config).
Because it prefers the session ID, two agents sharing one directory still show different
badges. It prints nothing for unroled sessions. Add `"refreshInterval": 10` under
`statusLine` to make the message count tick without needing an event.

**2. `bus_status`** — ask any session what it is; also shows round count and halted state.

**3. Startup line** — `agent-bus ready — role=reviewer …` is logged when the session opens,
though it scrolls away.

Naming the sessions helps too: `copilot --name "pr-42 reviewer"`.

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `role` | *(none)* | `coder` or `reviewer`. No role → extension is inert. |
| `peer` | the other role | Who your events are addressed to. |
| `topic` | `default` | Channel name. Both agents must match. |
| `pr` / `repo` | `null` | Enables GitHub polling and richer prompts. `repo` is `owner/name`. |
| `maxRounds` | `12` | Hard cap on handoffs before the loop stops itself. |
| `narrowAfterRounds` | `4` | After this many rounds, reviews narrow to high severity only. |
| `stopWhenClean` | `2` | Consecutive review passes with no new findings that end the loop. |
| `enforceRoles` | `true` | Block out-of-lane tool calls (see below). |
| `pollGitHub` | `true` | Poll the PR as a backstop. Requires `pr` + `repo` + `gh`. Reviews left by the PR author or by the locally authenticated account are ignored — they are yours, not the peer's. |
| `pollSeconds` | `30` | Poll interval. |
| `debugLog` | `null` | Path to write every delivery decision. Invaluable when nothing happens. |

Top-level keys act as defaults for all workspaces. Env vars
(`COPILOT_BUS_ROLE`, `_PEER`, `_TOPIC`, `_PR`, `_REPO`, `_DIR`) override both.

## Tools

| Tool | Purpose |
| --- | --- |
| `bus_join` | Claim a role for *this* session at runtime (`role`, plus optional `topic`, `pr`, `repo`, `peer`). Persisted in `sessions.json` by session ID. |
| `bus_leave` | Release this session's role. The extension goes inert again. |
| `bus_publish` | Announce an event to the peer. The coder's pushes publish automatically; use this for reviews, questions, and handoffs. Reviews carry a `findings` array that enters the shared ledger. |
| `bus_resolve` | Close ledger items by id (`resolved` or `retracted`), recorded against the head SHA at the time. |
| `bus_decide` | Record a human decision as a binding instruction the peer cannot close or argue away. |
| `bus_status` | Role, topic, round count, narrowing state, open ledger items, halted state, `roleSource`, recent traffic. |
| `bus_halt` | Stop the loop for this session and tell the peer. |

`bus_join` and `bus_status` are available even in an unroled session — that's how a fresh
session bootstraps itself. The rest require a role.

## Role enforcement

With `enforceRoles: true` (default), `preToolUse` denies:

- **reviewer** — `git push`, `git commit`, `gh pr merge`, and the `edit` / `create` / `write` tools
- **coder** — `gh pr review`

This is a real guardrail, not advice: the tool call never executes. Belt-and-braces version
at launch time:

```bash
copilot --deny-tool='shell(git push)' --deny-tool='write'   # reviewer
```

## Loop safety

Two agents that can prompt each other will happily ping-pong forever. Guards, in order:

1. **Self-filter** — an agent never reacts to its own events.
2. **Address filter** — only messages `to` your role (or `*`) are delivered.
3. **Topic filter** — other channels are ignored.
4. **ID dedupe** — each message is delivered at most once.
5. **`dedupeKey` dedupe** — the `git push` hook and the GitHub poller both announce a push;
   whichever notices first wins, keyed on the commit SHA (`push:<sha>`) or review id
   (`review:<id>`). No double-review.
6. **Audience guard** — every event type has exactly one sensible recipient role
   (`pr_pushed` → reviewer, `review_submitted` → coder). An event arriving at the wrong role
   is dropped with a warning, no matter what its `to` field says. This is what stops an
   author from ever being asked to review their own PR.
7. **Supersession** — when a drain picks up several pushes or reviews at once, only the
   newest is injected. Reviewing a commit that has already been replaced burns a whole round.
8. **Replay guard** — a `pr_pushed` whose head at *delivery* matches the last push already
   handed over is dropped without burning a round. Two pushes seconds apart both resolve to
   the same live head by the time the reviewer is free, and the second is a re-read of code
   it just reviewed. Only pushes are suppressed this way: a second review at an unchanged
   head can carry genuinely new findings, so those are always delivered.
9. **Round cap** — `maxRounds` handoffs, then the session halts and logs a warning
   instead of injecting. Rounds are counted locally, one per delivered handoff.
10. **Narrowing** — past `narrowAfterRounds`, non-high findings are dropped at publish time.
11. **Convergence** — `stopWhenClean` consecutive reviews with no new findings end the loop,
    subject to two conditions. A clean pass only counts if head moved since the previous pass
    (reviewing unchanged code proves nothing new), and the loop will not declare itself
    converged while the ledger still holds open findings — it publishes the review as a
    normal pass and tells the reviewer which items still need a push.

## Events

| Type | Direction | Emitted by |
| --- | --- | --- |
| `pr_pushed` | coder → reviewer | automatic on `git push` / `gh pr create`, or GitHub poll |
| `review_submitted` | reviewer → coder | `bus_publish`, or GitHub poll |
| `question` | either | `bus_publish` |
| `decision` | either | `bus_decide` — carries `authority: "human"` |
| `done` | either | `bus_halt`, or automatically after `stopWhenClean` clean passes |

## Troubleshooting

**Nothing happens on the reviewer side.** Run `bus_status` in both sessions and confirm the
`topic` matches and neither is `halted`. Set `debugLog` and read it — every skip is recorded
with a reason.

**No `bus_*` tools.** The session has no role. Check `bus_status` isn't present because
`resolveWorkspace` didn't match your cwd; the key must be the **real** path (symlinks are
resolved).

**Changed the extension or config.** Both are read at extension startup only. Run
`extensions_reload` (or `/clear`) — editing the file alone does nothing. This applies to
`config.json` too: a role change needs a reload.

**The loop stopped mid-flight.** Almost certainly the round cap. Raise `maxRounds`, or
reload the extension to reset the counter.

## Message format

Append-only JSONL at `~/.copilot/agent-bus/<topic>.jsonl` — greppable, replayable, and
survives restarts:

```json
{"id":"…","ts":"…","topic":"pr-42","from":"coder","to":"reviewer",
 "type":"pr_pushed","body":"…","pr":42,"headSha":"a1b2c3…","dedupeKey":"push:a1b2c3","round":1}
```

`headSha` binds an event to the commit it describes. The receiver re-resolves live head at
*delivery* time and, when they differ, the prompt says so explicitly and tells the agent to
diff the two rather than re-litigate work that has already been fixed.

The findings ledger lives beside it at `~/.copilot/agent-bus/<topic>.findings.json`:

```json
{"findings":{"F1":{"id":"F1","title":"nil deref in handler","severity":"high",
 "status":"open","openedSha":"a1b2c3…","openedBy":"reviewer"}},
 "decisions":{"D1":{"id":"D1","title":"bump memory to 512Mi","status":"open"}}}
```

Open items are rendered into every prompt, so neither agent has to reconstruct "fixed in X,
fixed in Y" by hand each round. The rendered list is a snapshot taken at delivery, which can
be while the peer is mid-turn, so it carries its timestamp and a pointer to `bus_status` as
the authoritative view.

Any process that can append a line can drive an agent. That's the extension point — CI, a
webhook receiver, or a `gh` alias can all publish events.

## Known limits

- Local filesystem only; both sessions must be on the same machine. For cross-machine, set
  `pr`/`repo` and lean on GitHub polling as the transport.
- The push hook reads `HEAD` from the **session's** working directory, so the coder session's
  cwd should be the repo it's pushing.
- The bus only wakes sessions that are actually running; `-p` runs exit immediately, so the
  inbound half is only useful in long-lived interactive sessions.
- Round counters are per-session, so the two terminals can show different numbers for the
  same exchange. Each counts the handoffs *it* received; neither is wrong.

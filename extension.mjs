/**
 * agent-bus — cross-session message bus for Copilot CLI.
 *
 * Lets two long-lived interactive sessions (a coding agent and a review agent)
 * hand work back and forth without a human relaying messages.
 *
 * A session has no role until it claims one. Roles resolve in this order:
 *   1. COPILOT_BUS_ROLE env var
 *   2. sessions.json[sessionId]  — set at runtime by the bus_join tool
 *   3. workspaces[<cwd>].role in config.json
 * Without a role the bus is dormant: hooks no-op and the watcher never starts,
 * but bus_join / bus_status stay available so a session can opt in at any time.
 */
import { joinSession } from "@github/copilot-sdk/extension";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

const BUS_DIR = process.env.COPILOT_BUS_DIR || path.join(os.homedir(), ".copilot", "agent-bus");
const CONFIG_PATH = path.join(BUS_DIR, "config.json");
const SESSIONS_PATH = path.join(BUS_DIR, "sessions.json");

fs.mkdirSync(BUS_DIR, { recursive: true });

const ROLES = ["coder", "reviewer"];
const SEVERITIES = ["high", "medium", "low"];

/**
 * An event only ever makes sense for one role. Checked at delivery as a structural
 * backstop: a publisher that gets `to` wrong can otherwise ask the author to review
 * their own PR, which is exactly what the GitHub poller used to do.
 */
const EVENT_AUDIENCE = {
    pr_pushed: "reviewer",
    review_submitted: "coder",
    review_addressed: "reviewer",
};

/** Types where only the newest instance matters; older ones describe superseded code. */
const SUPERSEDING = ["pr_pushed", "review_submitted", "review_addressed"];

function readJson(p, fallback) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(p, value) {
    const tmp = `${p}.tmp${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, p);
}

/** Tool args arrive as an object for some tools and a JSON string for others (e.g. bash). */
function toolArgsOf(input) {
    const a = input?.toolArgs;
    if (typeof a === "string") {
        try {
            return JSON.parse(a);
        } catch {
            return {};
        }
    }
    return a || {};
}

function resolveWorkspace(cfg, dir) {
    const spaces = cfg.workspaces || {};
    if (spaces[dir]) return spaces[dir];
    // Longest matching path prefix, so subdirectories inherit their repo's config.
    const match = Object.keys(spaces)
        .filter((k) => dir === k || dir.startsWith(k.endsWith(path.sep) ? k : k + path.sep))
        .sort((a, b) => b.length - a.length)[0];
    return match ? spaces[match] : {};
}

let cwd = process.cwd();
try {
    cwd = fs.realpathSync(cwd);
} catch {}

const cfg = readJson(CONFIG_PATH, {});
const ws = resolveWorkspace(cfg, cwd);

const DEBUG_LOG = ws.debugLog ?? cfg.debugLog ?? null;

/** Mutable session state. Seeded at startup, changeable at runtime via bus_join. */
const state = {
    role: null,
    peer: null,
    topic: "default",
    pr: null,
    repo: null,
    maxRounds: ws.maxRounds ?? cfg.maxRounds ?? 12,
    enforce: ws.enforceRoles ?? cfg.enforceRoles ?? true,
    pollSeconds: ws.pollSeconds ?? cfg.pollSeconds ?? 30,
    pollGitHub: ws.pollGitHub ?? cfg.pollGitHub ?? true,
    narrowAfterRounds: ws.narrowAfterRounds ?? cfg.narrowAfterRounds ?? 4,
    stopWhenClean: ws.stopWhenClean ?? cfg.stopWhenClean ?? 2,
    round: 0,
    cleanStreak: 0,
    lastAnnouncedSha: null,
    lastPushShaInjected: null,
    lastReviewedSha: null,
    halted: false,
    source: null,
};

const seen = new Set();
let offset = 0;
let watching = false;
let pollTimer = null;
let session = null;

function trace(decision, detail) {
    if (!DEBUG_LOG) return;
    try {
        fs.appendFileSync(
            DEBUG_LOG,
            JSON.stringify({ ts: new Date().toISOString(), role: state.role, decision, ...detail }) + "\n",
        );
    } catch {}
}

function logPath() {
    return path.join(BUS_DIR, `${slugTopic(state.topic)}.jsonl`);
}

/**
 * Topics become filenames, so keep them to a safe charset. Also stops a topic
 * like "../../etc/foo" from escaping BUS_DIR.
 */
function slugTopic(t) {
    return (
        String(t || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^[-.]+|[-.]+$/g, "")
            .slice(0, 80) || "default"
    );
}

function otherRole(role) {
    return role === "coder" ? "reviewer" : "coder";
}

/**
 * Binds a role to this session and starts the watcher. Safe to call repeatedly;
 * switching topics rebinds the watcher to the new log and resets the round count.
 */
function applyRole({ role, peer, topic, pr, repo, source }) {
    const changedTopic = topic && topic !== state.topic;
    state.role = role;
    state.peer = peer || otherRole(role);
    if (topic) state.topic = slugTopic(topic);
    if (pr !== undefined && pr !== null) state.pr = pr;
    if (repo !== undefined && repo !== null) state.repo = repo;
    state.source = source;
    state.halted = false;

    if (changedTopic) {
        seen.clear();
        state.round = 0;
    }

    const p = logPath();
    if (!fs.existsSync(p)) fs.writeFileSync(p, "");
    // Only consume messages published after this session joined.
    offset = fs.statSync(p).size;

    startWatching();
    startGitHubPolling();
}

function persistSessionRole(sessionId) {
    if (!sessionId) return;
    const all = readJson(SESSIONS_PATH, {});
    all[sessionId] = {
        role: state.role,
        peer: state.peer,
        topic: state.topic,
        pr: state.pr,
        repo: state.repo,
        cwd,
        ts: new Date().toISOString(),
    };
    // Keep the file from growing without bound across many sessions.
    const entries = Object.entries(all).sort((a, b) => String(b[1].ts).localeCompare(String(a[1].ts)));
    writeJson(SESSIONS_PATH, Object.fromEntries(entries.slice(0, 50)));
}

function clearSessionRole(sessionId) {
    const all = readJson(SESSIONS_PATH, {});
    if (sessionId && all[sessionId]) {
        delete all[sessionId];
        writeJson(SESSIONS_PATH, all);
    }
}

function allMessages() {
    try {
        return fs
            .readFileSync(logPath(), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

/** Shared findings ledger for the topic — the state both agents kept rebuilding by hand. */
function ledgerPath() {
    return path.join(BUS_DIR, `${slugTopic(state.topic)}.findings.json`);
}

function readLedger() {
    const l = readJson(ledgerPath(), {});
    return { findings: l.findings || {}, decisions: l.decisions || {} };
}

function normalizeSeverity(s) {
    const v = String(s || "medium").toLowerCase();
    return SEVERITIES.includes(v) ? v : "medium";
}

function narrowing() {
    return state.round >= state.narrowAfterRounds;
}

function addFindings(list, sha) {
    if (!Array.isArray(list) || !list.length) return [];
    const l = readLedger();
    const added = [];
    let n = Object.keys(l.findings).length;
    for (const f of list) {
        const entry = {
            id: `F${++n}`,
            title: String(f?.title || f || "").slice(0, 300),
            severity: normalizeSeverity(f?.severity),
            status: "open",
            openedSha: sha || null,
            openedBy: state.role,
            ts: new Date().toISOString(),
        };
        l.findings[entry.id] = entry;
        added.push(entry);
    }
    writeJson(ledgerPath(), l);
    return added;
}

/** Decisions come from the human, so they are recorded separately and cannot be argued closed. */
function addDecision({ title, detail }) {
    const l = readLedger();
    const id = `D${Object.keys(l.decisions).length + 1}`;
    l.decisions[id] = {
        id,
        title: String(title || "").slice(0, 300),
        detail: detail || "",
        status: "open",
        raisedBy: state.role,
        ts: new Date().toISOString(),
    };
    writeJson(ledgerPath(), l);
    return l.decisions[id];
}

function closeLedgerItems(ids, status, note, sha) {
    const l = readLedger();
    const closed = [];
    const missing = [];
    for (const raw of ids) {
        const id = String(raw).toUpperCase();
        const item = l.findings[id] || l.decisions[id];
        if (!item) {
            missing.push(id);
            continue;
        }
        item.status = status;
        item.resolvedSha = sha || null;
        item.resolvedNote = note || "";
        item.resolvedBy = state.role;
        item.resolvedTs = new Date().toISOString();
        closed.push(item);
    }
    writeJson(ledgerPath(), l);
    return { closed, missing };
}

function openFindings() {
    return Object.values(readLedger().findings).filter((f) => f.status === "open");
}

function openDecisions() {
    return Object.values(readLedger().decisions).filter((d) => d.status === "open");
}

/** Injected into every prompt so neither side re-derives "fixed in X, fixed in Y". */
function renderLedger() {
    const findings = openFindings();
    const decisions = openDecisions();
    let out = "";
    if (decisions.length) {
        out +=
            `\n\nOPEN DECISIONS — these are the human's calls, relayed through an agent. They are not the peer's ` +
            `opinion and are not negotiable: implement them, or state plainly that you are blocked and why. ` +
            `You may not close or defer them yourself.\n` +
            decisions.map((d) => `  [${d.id}] ${d.title}${d.detail ? ` — ${d.detail}` : ""}`).join("\n");
    }
    if (findings.length) {
        out +=
            `\n\nOPEN FINDINGS (shared ledger — close with bus_resolve, and do not re-raise what is already listed):\n` +
            findings
                .map(
                    (f) =>
                        `  [${f.id}] ${f.severity.toUpperCase()} ${f.title}` +
                        (f.openedSha ? ` (raised on ${String(f.openedSha).slice(0, 8)})` : ""),
                )
                .join("\n");
    }
    // A prompt is rendered when the event is delivered, which can be while the peer is
    // mid-turn: the snapshot below goes stale the moment either side calls bus_resolve.
    if (out) {
        out += `\n\nLedger snapshot taken ${new Date().toISOString()}. If you have resolved anything since, ` +
            `call bus_status — it is authoritative, this list is not.`;
    }
    return out;
}

/**
 * Append a message. `from` is overridable because the GitHub poller reports on the
 * *peer's* activity — it must be attributed to the peer, not to the polling session.
 */
function publish({ from, to, type, body, dedupeKey, headSha, findingIds, authority }) {
    if (!state.role) return { skipped: true, reason: "this session has no bus role" };
    if (state.halted) return { skipped: true, reason: "this session is halted" };
    if (dedupeKey && allMessages().some((m) => m.dedupeKey === dedupeKey)) {
        return { skipped: true, reason: `duplicate dedupeKey ${dedupeKey}` };
    }
    const msg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        topic: state.topic,
        from: from || state.role,
        to,
        type,
        body,
        pr: state.pr || undefined,
        headSha: headSha || undefined,
        findings: findingIds?.length ? findingIds : undefined,
        authority: authority || undefined,
        dedupeKey,
        round: state.round + 1,
    };
    fs.appendFileSync(logPath(), JSON.stringify(msg) + "\n");
    return { skipped: false, msg };
}

function statusObject() {
    return {
        role: state.role,
        peer: state.peer,
        topic: state.topic,
        pr: state.pr,
        repo: state.repo,
        round: state.round,
        maxRounds: state.maxRounds,
        narrowedToHighSeverity: narrowing(),
        narrowAfterRounds: state.narrowAfterRounds,
        cleanReviewStreak: state.cleanStreak,
        halted: state.halted,
        enforceRoles: state.enforce,
        gitHubPolling: !!pollTimer,
        roleSource: state.source,
        log: state.role ? logPath() : null,
        openDecisions: state.role ? openDecisions().map((d) => `[${d.id}] ${d.title}`) : [],
        openFindings: state.role
            ? openFindings().map((f) => `[${f.id}] ${f.severity.toUpperCase()} ${f.title}`)
            : [],
        recent: allMessages()
            .slice(-8)
            .map((m) => `${m.ts} ${m.from}->${m.to} ${m.type}${m.headSha ? ` @${String(m.headSha).slice(0, 8)}` : ""}`),
    };
}

session = await joinSession({
    tools: [
        {
            name: "bus_join",
            description:
                "Claim an agent-bus role for THIS session so it can hand work to a peer agent. " +
                "Call this when the user says something like 'you are the reviewer' or 'you're the coding agent for PR 42'. " +
                "Roles: 'coder' writes code and pushes; 'reviewer' reviews and never pushes.",
            parameters: {
                type: "object",
                properties: {
                    role: { type: "string", enum: ROLES, description: "Role for this session" },
                    topic: {
                        type: "string",
                        description:
                            "Optional. Channel shared with the peer agent. Leave it out and it is derived from the " +
                            "current repo + PR (or branch), which both sessions resolve identically. Only pass it to " +
                            "override, or when the user names a channel explicitly.",
                    },
                    pr: { type: "number", description: "Pull request number (optional, enables GitHub polling)" },
                    repo: { type: "string", description: "owner/name (optional, enables GitHub polling)" },
                },
                required: ["role"],
            },
            handler: async (args, invocation) => {
                if (!ROLES.includes(args.role)) return `Invalid role. Use one of: ${ROLES.join(", ")}`;

                // Only reach for git/gh when the user didn't pin a topic themselves.
                let topic = args.topic;
                let pr = args.pr;
                let repo = args.repo;
                let how = null;
                if (!topic) {
                    const d = await deriveTopic({ pr, repo, dir: cwd });
                    topic = d.topic || state.topic;
                    pr = pr ?? d.pr;
                    repo = repo || d.repo;
                    how = d.how;
                }

                applyRole({ role: args.role, topic, pr, repo, source: "bus_join" });
                persistSessionRole(invocation?.sessionId || session?.sessionId);
                await session.log(
                    `agent-bus: joined as ${state.role} on topic "${state.topic}"` +
                        (state.pr ? ` (PR #${state.pr})` : ""),
                );
                return (
                    `This session is now the "${state.role}" agent on topic "${state.topic}"` +
                    (state.pr ? ` for PR #${state.pr}` : "") +
                    `. Peer: "${state.peer}". ` +
                    (how ? `Topic was derived automatically from ${how}. ` : "") +
                    (state.role === "reviewer"
                        ? "You review code and must not push, commit, or edit files. Run `git fetch` and open each review with " +
                          "\"Reviewing <sha>\". Publish findings with bus_publish (type=review_submitted) including a findings array, " +
                          "and verify claims against the code rather than asserting them."
                        : "You write code. Pushes are announced to the reviewer automatically; do not review your own PR. " +
                          "Close review items with bus_resolve rather than re-describing what you fixed.") +
                    ` The peer session should call bus_join with role="${state.peer}"` +
                    (how
                        ? ` — if it is on the same PR or branch it will derive topic "${state.topic}" by itself.`
                        : ` and topic "${state.topic}".`)
                );
            },
        },
        {
            name: "bus_leave",
            description: "Drop this session's agent-bus role. It stops sending and receiving bus events.",
            parameters: { type: "object", properties: {} },
            handler: async (args, invocation) => {
                const was = state.role;
                state.role = null;
                state.peer = null;
                state.source = null;
                state.pr = null;
                state.repo = null;
                state.topic = "default";
                state.round = 0;
                state.halted = false;
                seen.clear();
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
                clearSessionRole(invocation?.sessionId || session?.sessionId);
                return was ? `Left the bus (was "${was}").` : "This session had no bus role.";
            },
        },
        {
            name: "bus_status",
            description: "Show this session's agent-bus role, topic, PR, round count, and recent traffic.",
            parameters: { type: "object", properties: {} },
            handler: async () => JSON.stringify(statusObject(), null, 2),
        },
        {
            name: "bus_publish",
            description:
                "Publish an event to the shared agent bus, notifying the peer agent. " +
                "Use after finishing a unit of work the other agent must act on " +
                "(e.g. you submitted a review). Pushes are published automatically.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        description: "Event type: pr_pushed, review_submitted, review_addressed, question, done",
                    },
                    body: {
                        type: "string",
                        description:
                            "Handoff instructions for the peer agent. Be specific and self-contained — the peer does not share your context.",
                    },
                    findings: {
                        type: "array",
                        description:
                            "For review_submitted: the issues you are raising, one entry each. They enter the shared " +
                            "ledger so the peer can close them by id instead of re-deriving what is fixed. " +
                            "Publish an empty array when a pass finds nothing new — consecutive clean passes end the loop.",
                        items: {
                            type: "object",
                            properties: {
                                title: { type: "string", description: "One-line statement of the issue" },
                                severity: {
                                    type: "string",
                                    enum: SEVERITIES,
                                    description:
                                        "high = correctness, data loss, security, or a broken public contract. " +
                                        "medium/low = everything else, and these are dropped once the loop narrows.",
                                },
                            },
                            required: ["title", "severity"],
                        },
                    },
                    to: { type: "string", description: "Recipient role (defaults to your peer)" },
                },
                required: ["type", "body"],
            },
            handler: async (args) => {
                if (!state.role) return "This session has no bus role. Call bus_join first.";

                const sha = await liveHead();
                let notes = [];
                let added = [];

                if (args.type === "review_submitted") {
                    let incoming = Array.isArray(args.findings) ? args.findings : [];

                    // After the narrowing point, low/medium findings cost more than they return.
                    if (narrowing()) {
                        const kept = incoming.filter((f) => normalizeSeverity(f?.severity) === "high");
                        const dropped = incoming.length - kept.length;
                        if (dropped) {
                            notes.push(
                                `dropped ${dropped} non-high finding(s): past round ${state.narrowAfterRounds} this loop is high-severity only`,
                            );
                        }
                        incoming = kept;
                    }

                    added = addFindings(incoming, sha);

                    // A pass over code that has not changed proves nothing new — counting it
                    // let two no-op passes end a loop that still had open findings on it.
                    const headMoved = !sha || sha !== state.lastReviewedSha;
                    if (added.length) {
                        state.cleanStreak = 0;
                    } else if (headMoved) {
                        state.cleanStreak += 1;
                    } else {
                        notes.push(
                            `clean streak held at ${state.cleanStreak}: head has not moved since your last pass, so this ` +
                                `pass reviewed the same code`,
                        );
                    }
                    state.lastReviewedSha = sha || state.lastReviewedSha;

                    const stillOpen = openFindings();
                    if (state.cleanStreak >= state.stopWhenClean && stillOpen.length) {
                        state.cleanStreak = state.stopWhenClean - 1;
                        const r = publish({
                            to: state.peer,
                            type: args.type,
                            body: args.body,
                            headSha: sha,
                        });
                        return (
                            `Not converging: ${stillOpen.length} finding(s) are still open in the ledger — ` +
                            `${stillOpen.map((f) => `${f.id} (${f.severity})`).join(", ")}. Two clean passes end the loop ` +
                            `only when the ledger is empty, so the review was published as a normal pass instead of a ` +
                            `"done"${r.skipped ? ` (publish skipped: ${r.reason})` : ""}. Tell the coder plainly which ` +
                            `items still need a push, or close them with bus_resolve if they are no longer valid.`
                        );
                    }

                    if (state.cleanStreak >= state.stopWhenClean) {
                        const r = publish({
                            to: state.peer,
                            type: "done",
                            headSha: sha,
                            body:
                                `${state.cleanStreak} consecutive review passes found no new issues — the review has converged. ` +
                                `Stopping here rather than spending more rounds.`,
                        });
                        state.halted = true;
                        return (
                            `No new findings for ${state.cleanStreak} passes in a row, so the loop is complete and this ` +
                            `session has halted${r.skipped ? "" : " and told the peer"}. Summarise the outcome for the user.`
                        );
                    }
                }

                const r = publish({
                    to: args.to || state.peer,
                    type: args.type,
                    body: args.body,
                    headSha: sha,
                    findingIds: added.map((f) => f.id),
                });
                if (r.skipped) return `skipped: ${r.reason}`;

                const ledgerNote = added.length
                    ? ` Logged ${added.map((f) => `${f.id} (${f.severity})`).join(", ")}.`
                    : "";
                const shaNote = sha ? ` Bound to head ${sha.slice(0, 8)}.` : "";
                return (
                    `published ${args.type} -> ${r.msg.to}.${shaNote}${ledgerNote}` +
                    (notes.length ? ` Note: ${notes.join("; ")}.` : "")
                );
            },
        },
        {
            name: "bus_resolve",
            description:
                "Close items in the shared findings ledger. Use 'resolved' for issues you actually fixed and " +
                "'retracted' for ones withdrawn after checking. Keeps both agents on one view of what is still open.",
            parameters: {
                type: "object",
                properties: {
                    ids: {
                        type: "array",
                        items: { type: "string" },
                        description: "Ledger ids, e.g. [\"F1\",\"F3\"]. Decisions (D1…) may only be closed by the human's agent.",
                    },
                    status: { type: "string", enum: ["resolved", "retracted"], description: "Defaults to resolved" },
                    note: { type: "string", description: "How it was addressed, or why it was withdrawn" },
                },
                required: ["ids"],
            },
            handler: async (args) => {
                if (!state.role) return "This session has no bus role. Call bus_join first.";
                const sha = await liveHead();
                const { closed, missing } = closeLedgerItems(
                    args.ids || [],
                    args.status === "retracted" ? "retracted" : "resolved",
                    args.note,
                    sha,
                );
                const parts = [];
                if (closed.length)
                    parts.push(
                        `${args.status === "retracted" ? "Retracted" : "Resolved"} ${closed
                            .map((c) => c.id)
                            .join(", ")}${sha ? ` against ${sha.slice(0, 8)}` : ""}.`,
                    );
                if (missing.length) parts.push(`Unknown id(s): ${missing.join(", ")}.`);
                const still = openFindings().length + openDecisions().length;
                parts.push(`${still} item(s) still open.`);
                return parts.join(" ");
            },
        },
        {
            name: "bus_decide",
            description:
                "Record a decision the human made, as a binding instruction to the peer agent. Use this whenever you " +
                "relay a human call (e.g. a sizing or scope decision) — unlike a review finding, the peer may not " +
                "close it, defer it, or argue it away. Use it instead of bus_publish when the instruction is not your opinion.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "The decision, stated as an instruction" },
                    detail: { type: "string", description: "Any context or constraints the peer needs to carry it out" },
                },
                required: ["title"],
            },
            handler: async (args) => {
                if (!state.role) return "This session has no bus role. Call bus_join first.";
                const d = addDecision({ title: args.title, detail: args.detail });
                const sha = await liveHead();
                const r = publish({
                    to: state.peer,
                    type: "decision",
                    authority: "human",
                    headSha: sha,
                    body: `Decision from the human (${d.id}): ${d.title}${d.detail ? `\n\n${d.detail}` : ""}`,
                });
                return r.skipped
                    ? `Recorded ${d.id} but did not notify the peer: ${r.reason}`
                    : `Recorded ${d.id} and sent it to the ${state.peer} as a binding decision. It stays on every prompt until closed with bus_resolve.`;
            },
        },
        {
            name: "bus_halt",
            description: "Stop the agent-bus loop for this session. Use when work is done or the agents are looping.",
            parameters: {
                type: "object",
                properties: { reason: { type: "string" } },
                required: ["reason"],
            },
            handler: async (args) => {
                if (!state.role) return "This session has no bus role.";
                // Publish before halting: publish() refuses to send once halted.
                publish({ to: state.peer, type: "done", body: `Loop halted: ${args.reason}` });
                state.halted = true;
                return "agent-bus halted for this session";
            },
        },
    ],

    hooks: {
        // Keep each agent inside its lane. No-ops until a role is claimed.
        onPreToolUse: async (input) => {
            if (!state.role || !state.enforce) return;
            const cmd = String(toolArgsOf(input).command ?? "");
            const deny = (reason) => ({
                permissionDecision: "deny",
                permissionDecisionReason: `[agent-bus] ${reason}`,
            });

            if (state.role === "reviewer") {
                if (/\bgit\s+(push|commit)\b/.test(cmd))
                    return deny("The review agent does not write code. Publish findings with bus_publish instead.");
                if (/\bgh\s+pr\s+merge\b/.test(cmd)) return deny("The review agent does not merge PRs.");
                if (["edit", "create", "write"].includes(input.toolName))
                    return deny("The review agent is read-only. Report the issue instead of fixing it.");
            }
            if (state.role === "coder" && /\bgh\s+pr\s+review\b/.test(cmd)) {
                return deny("The coding agent does not review its own PR.");
            }
        },

        // Auto-publish when the coder actually pushes.
        onPostToolUse: async (input) => {
            if (state.halted || state.role !== "coder" || input.toolName !== "bash") return;
            const cmd = String(toolArgsOf(input).command ?? "");
            if (!/\bgit\s+push\b/.test(cmd) && !/\bgh\s+pr\s+create\b/.test(cmd)) return;

            // A missing SHA means a missing dedupeKey, which lets the poller announce the
            // same push a second time — so try hard for one.
            const sha = (await gitHead(input.workingDirectory)) || (await gitHead(cwd)) || (await liveHead());
            if (sha && sha === state.lastAnnouncedSha) {
                trace("skip:no-op-push", { sha });
                return;
            }
            if (sha) state.lastAnnouncedSha = sha;
            publish({
                to: state.peer,
                type: "pr_pushed",
                headSha: sha || undefined,
                dedupeKey: sha ? `push:${sha}` : undefined,
                body:
                    `The coding agent pushed to ${state.pr ? `PR #${state.pr}` : "the PR"}` +
                    (sha ? ` (head ${sha.slice(0, 8)})` : "") +
                    `. Please review the changes.`,
            });
        },

        onSessionStart: async () => {
            if (!state.role) return;
            return {
                additionalContext:
                    `[agent-bus] You are the "${state.role}" agent on topic "${state.topic}"` +
                    (state.pr ? ` for PR #${state.pr}` : "") +
                    `. Your peer is the "${state.peer}" agent. ` +
                    (state.role === "reviewer"
                        ? "You review code; you never push, commit, or edit files. Run `git fetch` before each pass and open the " +
                          "review with \"Reviewing <sha>\". When it is complete, call bus_publish with type=review_submitted and a findings array."
                        : "You write code; you never submit reviews of your own PR. Pushes are announced to the reviewer automatically. " +
                          "Close findings with bus_resolve once genuinely fixed.") +
                    ` After round ${state.narrowAfterRounds} the loop narrows to high-severity issues only, and ${state.stopWhenClean} ` +
                    `consecutive clean review passes end it.` +
                    " Decisions recorded with bus_decide come from the human and are not negotiable." +
                    " Call bus_status to inspect the loop, bus_halt to stop it.",
            };
        },
    },
});

// ---- seed a role for this session, if one was configured ahead of time ----
{
    const persisted = readJson(SESSIONS_PATH, {})[session.sessionId];
    const envRole = process.env.COPILOT_BUS_ROLE;

    if (envRole && ROLES.includes(envRole)) {
        applyRole({
            role: envRole,
            peer: process.env.COPILOT_BUS_PEER,
            topic: process.env.COPILOT_BUS_TOPIC || cfg.topic || "default",
            pr: process.env.COPILOT_BUS_PR || null,
            repo: process.env.COPILOT_BUS_REPO || null,
            source: "env",
        });
    } else if (persisted?.role) {
        applyRole({ ...persisted, source: "session" });
    } else if (ws.role) {
        applyRole({
            role: ws.role,
            peer: ws.peer,
            topic: ws.topic || cfg.topic || "default",
            pr: ws.pr ?? cfg.pr ?? null,
            repo: ws.repo ?? cfg.repo ?? null,
            source: "workspace",
        });
    }

    await session.log(
        state.role
            ? `agent-bus ready — role=${state.role} peer=${state.peer} topic=${state.topic}` +
                  (state.pr ? ` pr=#${state.pr}` : "") +
                  ` (via ${state.source})`
            : `agent-bus loaded — no role yet. Call bus_join to make this session a coder or reviewer.`,
    );
}

let draining = false;

async function drain() {
    if (!state.role || draining) return;
    const p = logPath();
    if (!fs.existsSync(p)) return;

    const size = fs.statSync(p).size;
    if (size <= offset) {
        offset = size; // handle truncation
        return;
    }

    draining = true;
    try {
        const fd = fs.openSync(p, "r");
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = size;

        const pending = [];
        for (const line of buf.toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }

            if (msg.topic !== state.topic) {
                trace("skip:topic", { id: msg.id, topic: msg.topic });
                continue;
            }
            if (msg.from === state.role) {
                trace("skip:self", { id: msg.id });
                continue;
            }
            if (msg.to !== state.role && msg.to !== "*") {
                trace("skip:not-addressed", { id: msg.id, to: msg.to });
                continue;
            }
            if (seen.has(msg.id)) {
                trace("skip:duplicate-id", { id: msg.id });
                continue;
            }
            seen.add(msg.id);

            // Backstop against a mis-addressed publisher: never ask an author to review
            // their own PR, whatever the `to` field claims.
            const audience = EVENT_AUDIENCE[msg.type];
            if (audience && audience !== state.role) {
                trace("skip:wrong-audience", { id: msg.id, type: msg.type, audience, from: msg.from });
                session.log(
                    `[agent-bus] dropped a "${msg.type}" event addressed to the ${state.role} — that event is only ever for the ${audience}.`,
                    { level: "warning" },
                );
                continue;
            }

            pending.push(msg);
        }

        if (!pending.length) return;

        // Keep only the newest of each superseding type; the earlier ones describe code
        // that has already been replaced, and reviewing them wastes a full round.
        const batch = [];
        for (let i = pending.length - 1; i >= 0; i--) {
            const msg = pending[i];
            if (SUPERSEDING.includes(msg.type) && batch.some((b) => b.type === msg.type)) {
                trace("skip:superseded", { id: msg.id, type: msg.type });
                continue;
            }
            batch.unshift(msg);
        }

        const live = await liveHead();

        for (const msg of batch) {
            if (msg.type === "done" || state.halted) {
                state.halted = true;
                trace("halt", { id: msg.id, type: msg.type });
                session.log(`[agent-bus] loop stopped: ${msg.body}`, { level: "info" });
                continue;
            }

            // A push is fully identified by its SHA, so a second announcement resolving to
            // a head we already handed over is a replay — deliver it and the reviewer burns
            // a round re-reading the same commit. Only pushes get this: a fresh review at an
            // unchanged head can still carry genuinely new findings.
            const effectiveSha = live || msg.headSha || null;
            if (msg.type === "pr_pushed" && effectiveSha && effectiveSha === state.lastPushShaInjected) {
                trace("skip:replay-same-head", { id: msg.id, sha: effectiveSha });
                session.log(
                    `[agent-bus] dropped a replayed push at ${effectiveSha.slice(0, 8)} — already delivered, no new commits.`,
                );
                continue;
            }

            // Counted locally: trusting the publisher's round number made the budget
            // drain at twice the rate of actual review passes.
            state.round += 1;
            if (state.round > state.maxRounds) {
                state.halted = true;
                trace("skip:round-cap", { id: msg.id, round: state.round, maxRounds: state.maxRounds });
                session.log(
                    `[agent-bus] round cap (${state.maxRounds}) reached — not injecting. The agents may be looping; intervene manually.`,
                    { level: "warning" },
                );
                continue;
            }

            const stale = !!(msg.headSha && live && msg.headSha !== live);
            if (msg.type === "pr_pushed") state.lastPushShaInjected = effectiveSha;
            trace("inject", { id: msg.id, type: msg.type, from: msg.from, round: state.round, stale });
            session.log(
                `[agent-bus] ${msg.type} from ${msg.from} (round ${state.round}/${state.maxRounds})` +
                    (stale ? " — event is stale, prompt pins live head" : ""),
            );
            session.send({ prompt: renderPrompt(msg, { live, stale }) });
        }
    } finally {
        draining = false;
    }
}

function renderPrompt(msg, ctx = {}) {
    const { live, stale } = ctx;
    const head = `[agent-bus] Event "${msg.type}" from the ${msg.from} agent (round ${state.round}/${state.maxRounds}):\n\n${msg.body}\n`;
    const prPart =
        state.pr && state.repo
            ? ` Use \`gh pr view ${state.pr} --repo ${state.repo}\` and \`gh pr diff ${state.pr} --repo ${state.repo}\`.`
            : "";

    // Resolved at delivery, not at publish: half of the last loop's rounds went to
    // arguing about which commit an event referred to.
    let shaBlock = "";
    if (live) {
        shaBlock = `\n\nHEAD AT DELIVERY: ${live}`;
        if (stale) {
            shaBlock +=
                `\nThis event was raised on ${String(msg.headSha).slice(0, 8)}, which is NO LONGER head. ` +
                `Work against ${live.slice(0, 8)} only. Run \`git fetch\` and diff ` +
                `${String(msg.headSha).slice(0, 8)}..${live.slice(0, 8)} before you respond, and do not re-litigate ` +
                `anything already fixed in between.`;
        }
    }

    const narrowNote = narrowing()
        ? `\n\nNARROWED SCOPE — this is round ${state.round} of ${state.maxRounds}. Report ONLY high-severity issues: ` +
          `correctness bugs, data loss, security problems, or a broken public contract. Do not raise style, naming, ` +
          `test-message or other low/medium nits; each one costs a full round and the fix can make the code worse. ` +
          `Non-high findings are dropped at publish time from here on. If you find no high-severity issues, say so ` +
          `and call bus_halt.`
        : "";

    if (msg.type === "decision") {
        return (
            head +
            shaBlock +
            renderLedger() +
            `\n\nThis is the human's decision relayed through the ${msg.from} agent, not a review finding and not an ` +
            `opinion to weigh. Implement it. If you genuinely cannot, reply with bus_publish type="question" saying ` +
            `exactly what blocks you — do not silently treat it as a suggestion, and do not close it yourself.`
        );
    }

    if (msg.type === "pr_pushed") {
        return (
            head +
            shaBlock +
            `\n\nRun \`git fetch\` first and pin the SHA you are reviewing. Start your review with the line ` +
            `"Reviewing <sha>" so a stale pass is obvious to the coder at a glance.${prPart}` +
            narrowNote +
            renderLedger() +
            `\n\nWhen you are done, call bus_publish with type="review_submitted", a body containing your findings, and ` +
            `a "findings" array (title + severity for each) so they enter the shared ledger. If this pass found nothing ` +
            `new, publish with an empty findings array — ${state.stopWhenClean} clean passes in a row end the loop. ` +
            `Verify claims against the code rather than asserting them, and do not edit or push.`
        );
    }

    if (msg.type === "review_submitted") {
        return (
            head +
            shaBlock +
            `\n\nAddress this review against ${live ? live.slice(0, 8) : "current head"}.${prPart}` +
            renderLedger() +
            `\n\nFix what is genuinely wrong, then call bus_resolve with the ids you fixed and push — the push is ` +
            `announced automatically, so do not call bus_publish for it. If a point is mistaken, push back with ` +
            `bus_publish type="question" instead of changing code you believe is correct: closing a finding is never ` +
            `worth making the code worse. Check that your fix does not break work stacked on this branch.`
        );
    }

    return head + shaBlock + renderLedger() + `\n\nRespond, then use bus_publish to reply to the ${msg.from} agent if a handoff is needed.`;
}

function startWatching() {
    if (watching) return;
    watching = true;
    fs.watch(BUS_DIR, () => {
        drain().catch(() => {});
    });
    // fs.watch is unreliable on some filesystems; poll as a backstop.
    setInterval(() => {
        drain().catch(() => {});
    }, 1000).unref?.();
}

function sh(cmd, args, cwdOverride) {
    return new Promise((resolve) => {
        execFile(cmd, args, { cwd: cwdOverride || cwd, timeout: 20000 }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
        );
    });
}

async function gitHead(dir) {
    return await sh("git", ["rev-parse", "HEAD"], dir);
}

let cachedLogin;
/** The GitHub account this machine is authenticated as. Cached; `null` when unknown. */
async function localLogin() {
    if (cachedLogin !== undefined) return cachedLogin;
    cachedLogin = (await sh("gh", ["api", "user", "-q", ".login"]))?.trim() || null;
    return cachedLogin;
}

/** Head as of right now. GitHub is authoritative when we know the PR, since the
 *  reviewer may not have the branch checked out locally. */
async function liveHead() {
    if (state.pr && state.repo) {
        const out = await sh("gh", [
            "pr", "view", String(state.pr),
            "--repo", state.repo,
            "--json", "headRefOid",
            "-q", ".headRefOid",
        ]);
        if (out) return out.trim();
    }
    return await gitHead(cwd);
}

async function ghRepo(dir) {
    return await sh("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], dir);
}

/** Fallback for when `gh` is unavailable or blocked by enterprise token policy. */
async function remoteRepo(dir) {
    const url = await sh("git", ["remote", "get-url", "origin"], dir);
    if (!url) return null;
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Works out a channel name both sessions will land on without being told.
 *
 * The PR number is the ideal key: a coder on the feature branch and a reviewer
 * who ran `gh pr checkout 42` both resolve the same PR, so they meet on the same
 * topic from different directories. Branch name is the fallback for pre-PR work.
 */
async function deriveTopic({ pr, repo, dir }) {
    const resolvedRepo = repo || (await ghRepo(dir)) || (await remoteRepo(dir));

    let resolvedPr = pr;
    if (!resolvedPr) {
        const n = await sh("gh", ["pr", "view", "--json", "number", "-q", ".number"], dir);
        if (n && /^\d+$/.test(n.trim())) resolvedPr = Number(n.trim());
    }

    if (resolvedRepo && resolvedPr) {
        return { topic: `${resolvedRepo}-pr-${resolvedPr}`, pr: resolvedPr, repo: resolvedRepo, how: `PR #${resolvedPr} in ${resolvedRepo}` };
    }

    const branch = await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir);
    if (resolvedRepo && branch && branch !== "HEAD") {
        return { topic: `${resolvedRepo}-${branch}`, pr: resolvedPr, repo: resolvedRepo, how: `branch "${branch}" in ${resolvedRepo}` };
    }
    if (resolvedRepo) {
        return { topic: resolvedRepo, pr: resolvedPr, repo: resolvedRepo, how: `repo ${resolvedRepo}` };
    }
    return { topic: null, pr: resolvedPr, repo: resolvedRepo, how: null };
}

/**
 * Polls the PR for new commits (reviewer) or new reviews (coder). The poller reports on
 * what the *peer* did, so events are attributed to the peer and addressed to this session —
 * attributing them to the polling session is what asked authors to review their own PRs.
 * dedupeKey makes this safe alongside the git-push hook: whichever notices first wins.
 */
function startGitHubPolling() {
    if (pollTimer || !state.pollGitHub || !state.pr || !state.repo) return;
    let baseline = null;

    async function tick() {
        if (state.halted || !state.role) return;
        const out = await sh("gh", [
            "pr", "view", String(state.pr),
            "--repo", state.repo,
            "--json", "headRefOid,reviews,author",
        ]);
        if (!out) return;
        let snap;
        try {
            snap = JSON.parse(out);
        } catch {
            return;
        }

        // First poll establishes a baseline without firing events.
        if (!baseline) {
            baseline = snap;
            return;
        }

        if (state.role === "reviewer" && snap.headRefOid && snap.headRefOid !== baseline.headRefOid) {
            publish({
                from: "coder",
                to: "reviewer",
                type: "pr_pushed",
                headSha: snap.headRefOid,
                dedupeKey: `push:${snap.headRefOid}`,
                body: `New commits on PR #${state.pr} (head ${String(snap.headRefOid).slice(0, 8)}). Please review.`,
            });
        }

        if (state.role === "coder") {
            const known = new Set((baseline.reviews || []).map((r) => String(r.id)));
            const prAuthor = String(snap.author?.login || "").toLowerCase();
            const me = String(await localLogin() || "").toLowerCase();
            for (const r of snap.reviews || []) {
                if (known.has(String(r.id))) continue;
                if (String(r.state).toUpperCase() === "PENDING") continue;
                // The poller cannot see who is driving the reviewer session, so a review left
                // by the PR author (usually the human at this keyboard) would otherwise be
                // announced as peer feedback and answered as if the reviewer had spoken.
                const login = String(r.author?.login || "").toLowerCase();
                if (login && (login === prAuthor || login === me)) {
                    trace("skip:own-review", { id: r.id, login });
                    continue;
                }
                publish({
                    from: "reviewer",
                    to: "coder",
                    type: "review_submitted",
                    headSha: snap.headRefOid,
                    dedupeKey: `review:${r.id}`,
                    body:
                        `A ${r.state} review landed on PR #${state.pr}` +
                        (login ? ` from @${r.author.login}` : "") +
                        `:\n\n${r.body || "(no body — check inline comments)"}`,
                });
            }
        }

        baseline = snap;
    }

    pollTimer = setInterval(() => {
        tick().catch(() => {});
    }, state.pollSeconds * 1000);
    pollTimer.unref?.();
}

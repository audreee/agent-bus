#!/usr/bin/env node
/**
 * agent-bus statusline badge.
 *
 * Reads the CLI status object on stdin and prints a persistent role badge so you
 * can tell at a glance which terminal is the coder and which is the reviewer.
 *
 * Wire it up in ~/.copilot/settings.json:
 *   "statusLine": { "type": "command", "command": "~/.copilot/agent-bus/statusline.mjs" }
 *
 * Prints nothing when the session has no role, so unroled sessions stay clean.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BUS_DIR = process.env.COPILOT_BUS_DIR || path.join(os.homedir(), ".copilot", "agent-bus");

function readStdin() {
    try {
        return fs.readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

function readJson(p, fallback) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return fallback;
    }
}

// Mirrors resolveWorkspace() in extension.mjs: longest path-prefix wins.
function resolveWorkspace(cfg, cwd) {
    const spaces = cfg.workspaces || {};
    if (spaces[cwd]) return spaces[cwd];
    const match = Object.keys(spaces)
        .filter((k) => cwd === k || cwd.startsWith(k.endsWith(path.sep) ? k : k + path.sep))
        .sort((a, b) => b.length - a.length)[0];
    return match ? spaces[match] : {};
}

const status = parseJson(readStdin());

function parseJson(s) {
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}

let cwd = status.cwd || status.workspace?.current_dir || process.cwd();
try {
    cwd = fs.realpathSync(cwd);
} catch {}

const cfg = readJson(path.join(BUS_DIR, "config.json"), {});
const ws = resolveWorkspace(cfg, cwd);

// Same resolution order as extension.mjs: env > bus_join (sessions.json) > config.
// The session_id lookup is what keeps two agents sharing one cwd distinguishable.
const sessions = readJson(path.join(BUS_DIR, "sessions.json"), {});
const claimed = (status.session_id && sessions[status.session_id]) || {};

const role = process.env.COPILOT_BUS_ROLE || claimed.role || ws.role || null;
if (!role) process.exit(0);

const topic = process.env.COPILOT_BUS_TOPIC || claimed.topic || ws.topic || cfg.topic || "default";
const pr = process.env.COPILOT_BUS_PR || claimed.pr || ws.pr || cfg.pr || null;

// ANSI: reviewer = magenta, coder = cyan. Inverse video makes it unmissable.
const color = role === "reviewer" ? "\u001b[45;97m" : "\u001b[46;30m";
const reset = "\u001b[0m";
const dim = "\u001b[2m";

const icon = role === "reviewer" ? "\u{1F50D}" : "\u{1F528}";
const badge = `${color} ${icon} ${role.toUpperCase()} ${reset}`;

// Round count = messages seen on this topic, so you can see the loop advancing.
let rounds = 0;
try {
    rounds = fs
        .readFileSync(path.join(BUS_DIR, `${topic}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean).length;
} catch {}

// Open ledger items — the count you actually care about mid-loop.
const ledger = readJson(path.join(BUS_DIR, `${topic}.findings.json`), {});
const openFindings = Object.values(ledger.findings || {}).filter((f) => f.status === "open");
const openDecisions = Object.values(ledger.decisions || {}).filter((d) => d.status === "open");
const highOpen = openFindings.filter((f) => f.severity === "high").length;

const parts = [badge, `${dim}bus:${topic}${reset}`];
if (pr) parts.push(`${dim}#${pr}${reset}`);
if (rounds) parts.push(`${dim}${rounds} msg${rounds === 1 ? "" : "s"}${reset}`);
if (openFindings.length) {
    const warn = highOpen ? "\u001b[31m" : dim;
    parts.push(`${warn}${openFindings.length} open${highOpen ? ` (${highOpen} high)` : ""}${reset}`);
}
if (openDecisions.length) parts.push(`\u001b[33m${openDecisions.length} decision${openDecisions.length === 1 ? "" : "s"}${reset}`);

process.stdout.write(parts.join(" "));

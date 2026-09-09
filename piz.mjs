#!/usr/bin/env node
// piz — pick which pi packages/skills to load at startup, then exec pi with a
// filtered config dir (PI_CODING_AGENT_DIR). Your real settings.json is never
// touched.
//
// Keys: ↑/↓ move · space toggle · x expand/collapse · enter done · esc cancel
// Flags: --no-prompt (reuse saved selection) · --show (print settings only)
//        · --selftest (verify resolution + filtering logic)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const STATE_FILE = path.join(os.homedir(), ".pi", "piz", "state.json");

const SELF_FLAGS = new Set(["--show", "--no-prompt", "--selftest", "--podman"]);
const argv = process.argv.slice(2);

// --image / --runtime take values; pull them out before passthrough so the
// value (and the flag itself) never leak into the pi/podman args.
function takeValue(args, name, def) {
  let v = def;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) v = args[++i];
    else if (args[i].startsWith(name + "=")) v = args[i].slice(name.length + 1);
    else rest.push(args[i]);
  }
  return [v, rest];
}
const [image, a1] = takeValue(argv, "--image", "ghcr.io/jcpowermac/piz-pi:latest");
const [runtime, a2] = takeValue(a1, "--runtime", "krun");
const flags = new Set(a2.filter((a) => a.startsWith("--")));
const passthrough = a2.filter((a) => !SELF_FLAGS.has(a));

// ---------- package discovery ----------

function pkgDir(src) {
  if (src.startsWith("npm:"))
    return path.join(AGENT_DIR, "npm", "node_modules", src.slice(4));
  if (src.startsWith("git:"))
    return path.join(AGENT_DIR, "git", src.slice(4).split("@")[0]);
  return path.isAbsolute(src) ? src : path.resolve(AGENT_DIR, src);
}

function loadPackage(src) {
  const dir = pkgDir(src);
  let manifest = {};
  try {
    manifest =
      JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
        .pi || {};
  } catch {}
  const skills = [];
  for (const s of manifest.skills || []) {
    const base = path.join(dir, s);
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!fs.existsSync(path.join(base, e.name, "SKILL.md"))) continue;
      skills.push({ name: e.name, relPath: path.posix.normalize(path.join(s, e.name)) });
    }
  }
  return { src, dir, manifest, skills };
}

// ---------- state ----------

function loadState(pkgs) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  const state = { packages: {}, excludeTools: saved.excludeTools || [] };
  for (const p of pkgs) {
    const cur = saved.packages?.[p.src];
    state.packages[p.src] = {
      enabled: cur ? !!cur.enabled : true,
      skills: Object.fromEntries(
        p.skills.map((sk) => [sk.name, cur ? !!cur.skills?.[sk.name] : true]),
      ),
      expanded: false,
    };
  }
  return state;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- filtering ----------

function allSkillsOn(p, st) {
  return p.skills.every((sk) => st.skills[sk.name]);
}

// pi resolves relative package paths against the settings file they appear
// in, and piz writes a temp settings file — so relative sources must be
// absolutized here or they point nowhere.
function resolvedSrc(p) {
  return p.src.startsWith("npm:") || p.src.startsWith("git:") || path.isAbsolute(p.src)
    ? p.src
    : p.dir;
}

function filteredPackages(state, pkgs) {
  const out = [];
  for (const p of pkgs) {
    const st = state.packages[p.src];
    if (!st.enabled) continue;
    const src = resolvedSrc(p);
    if (p.skills.length > 0 && !allSkillsOn(p, st)) {
      const sel = p.skills
        .filter((sk) => st.skills[sk.name])
        .map((sk) => sk.relPath);
      out.push({ source: src, skills: sel });
    } else {
      out.push(src);
    }
  }
  return out;
}

// ---------- picker ----------

function pick(state, pkgs) {
  const out = process.stdout;
  let cursor = 0;
  let lastLines = 0;
  let done = false;

  function rows() {
    const r = [];
    for (const p of pkgs) {
      const st = state.packages[p.src];
      r.push({ kind: "pkg", p, st });
      if (st.expanded)
        for (const sk of p.skills) r.push({ kind: "skill", p, sk, st });
    }
    return r;
  }

  function render() {
    const r = rows();
    let s =
      "\x1b[1mWhat should pi load?\x1b[0m  ↑/↓ move · space toggle · x expand · enter done · esc cancel\n";
    r.forEach((row, i) => {
      const cur = i === cursor ? "\x1b[7m" : "";
      const end = i === cursor ? "\x1b[0m" : "";
      let line;
      if (row.kind === "pkg") {
        const mark = !row.st.enabled
          ? "✗"
          : allSkillsOn(row.p, row.st)
            ? "✓"
            : "◐";
        const ext = row.p.manifest.extensions?.length || 0;
        const detail = `${row.p.skills.length} skills${ext ? `, ${ext} ext` : ""}`;
        line = ` [${mark}] ${row.st.expanded ? "▾" : "▸"} ${row.p.src} (${detail})`;
      } else {
        line = `      [${row.st.skills[row.sk.name] ? "✓" : " "}] ${row.sk.name}`;
      }
      s += `${cur}${line}${end}\n`;
    });
    if (lastLines > 0) out.write(`\x1b[${lastLines}A\x1b[J`);
    out.write(s);
    lastLines = s.split("\n").length - 1;
  }

  function toggle(row) {
    if (row.kind === "pkg") {
      const on = !row.st.enabled;
      row.st.enabled = on;
      for (const sk of row.p.skills) row.st.skills[sk.name] = on;
    } else {
      row.st.skills[row.sk.name] = !row.st.skills[row.sk.name];
    }
  }

  function onKey(data) {
    const r = rows();
    if (data === "\x1b[A") cursor = Math.max(0, cursor - 1);
    else if (data === "\x1b[B") cursor = Math.min(r.length - 1, cursor + 1);
    else if (data === " ") {
      toggle(r[cursor]);
      render();
      return;
    } else if (data === "x" || data === "e") {
      if (r[cursor].kind === "pkg") {
        r[cursor].st.expanded = !r[cursor].st.expanded;
        render();
        return;
      }
    } else if (data === "\r") {
      done = true;
      return;
    } else if (data === "\x1b") {
      done = false;
      cancel = true;
      return;
    } else {
      return;
    }
    render();
  }

  let cancel = false;
  return new Promise((resolve) => {
    out.write("\x1b[?25l");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      onKey(d.toString());
      if (done) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        out.write("\x1b[?25h\x1b[J\n");
        resolve(!cancel);
      }
    });
    render();
  });
}

function promptTools(state) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const current = state.excludeTools.join(",");
  return new Promise((resolve) =>
    rl.question(
      `Exclude tools (comma-sep, blank = keep ${current || "none"}): `,
      (ans) => {
        rl.close();
        const v = ans.trim();
        if (v) state.excludeTools = v.split(",").map((s) => s.trim());
        resolve();
      },
    ),
  );
}

// ---------- launch ----------

function makeConfigDir(settings) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piz-"));
  for (const e of fs.readdirSync(AGENT_DIR)) {
    if (e === "settings.json") continue;
    fs.symlinkSync(path.join(AGENT_DIR, e), path.join(tmp, e));
  }
  fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify(settings, null, 2));
  return tmp;
}

// For the VM: real copies, not symlinks (krun can't deref symlinks outside
// the mount) and not hardlinks (in-VM writes would hit host files via the
// link; /tmp is tmpfs vs home btrfs so cross-device links are impossible).
// Only npm/ + git/ are mounted in — sessions, auth.json, models stay out.
function materializeDir(settings) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piz-vm-"));
  // npm/ + git/ are the package trees; models.json carries the provider
  // definitions (baseUrl for llama-server etc.) that settings.json references.
  for (const d of ["npm", "git", "models.json"]) {
    const src = path.join(AGENT_DIR, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, d), { recursive: true });
  }
  fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify(settings, null, 2));
  return tmp;
}

function selftest(pkgs) {
  let fails = 0;
  const check = (cond, msg) => {
    console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
    if (!cond) fails++;
  };
  check(
    pkgs.every((p) => fs.existsSync(p.dir)),
    `all ${pkgs.length} package dirs resolve`,
  );
  const withSkills = pkgs.filter((p) => p.skills.length > 0);
  check(
    withSkills.length > 0,
    `found ${withSkills.reduce((n, p) => n + p.skills.length, 0)} skills in ${withSkills.length} packages`,
  );
  // filtering: disable one skill-having package, half-select another
  const state = loadState(pkgs);
  const p1 = withSkills[0];
  const p2 = withSkills[1] || withSkills[0];
  state.packages[p1.src].enabled = false;
  if (p2.skills.length > 1)
    state.packages[p2.src].skills[p2.skills[p2.skills.length - 1].name] = false;
  const filtered = filteredPackages(state, pkgs);
  check(
    filtered.every((e) => {
      const s = typeof e === "string" ? e : e.source;
      return s.startsWith("npm:") || s.startsWith("git:") || path.isAbsolute(s);
    }),
    "all emitted sources are absolute or scheme-prefixed",
  );
  const p1Src = resolvedSrc(p1);
  check(!filtered.some((e) => (e.source || e) === p1Src), "deselected package dropped");
  if (p2.skills.length > 1 && p1.src !== p2.src) {
    const p2Src = resolvedSrc(p2);
    const entry = filtered.find((e) => (e.source || e) === p2Src);
    check(
      !!entry && Array.isArray(entry.skills) && entry.skills.length === p2.skills.length - 1,
      `partial package uses object form with ${p2.skills.length - 1} skills`,
    );
  }
  process.exit(fails ? 1 : 0);
}

// ---------- main ----------

const settings = JSON.parse(
  fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf8"),
);
const pkgs = (settings.packages || []).map((p) =>
  typeof p === "string" ? p : p.source,
).map(loadPackage);
const state = loadState(pkgs);

if (flags.has("--selftest")) selftest(pkgs);

if (!flags.has("--no-prompt") && process.stdout.isTTY) {
  const ok = await pick(state, pkgs);
  if (!ok) process.exit(130);
  await promptTools(state);
}

saveState(state);
const filtered = { ...settings, packages: filteredPackages(state, pkgs) };

if (flags.has("--show")) {
  console.log(JSON.stringify(filtered, null, 2));
  process.exit(0);
}

if (flags.has("--podman")) {
  if (runtime === "krun" && !fs.existsSync("/dev/kvm")) {
    console.error("piz: krun requires /dev/kvm — enable KVM or retry with --runtime crun");
    process.exit(1);
  }
  const tmp = materializeDir(filtered);
  console.error(`piz: vm config dir: ${tmp} (image: ${image}, runtime: ${runtime})`);
  const args = [
    "run", `--runtime=${runtime}`, "--network", "host", "--rm", "-it",
    "-v", `${tmp}:/pi/agent:z`,
    "-v", `${process.cwd()}:/workspace:z`,
    "-e", "PI_CODING_AGENT_DIR=/pi/agent",
    "-w", "/workspace",
    image, "pi", ...passthrough,
  ];
  if (state.excludeTools.length) args.push("--exclude-tools", state.excludeTools.join(","));
  const r = spawnSync("podman", args, { stdio: "inherit" });
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(r.status ?? (r.error ? 1 : 0));
}

const tmp = makeConfigDir(filtered);
console.error(`piz: config dir: ${tmp}`);
const args = [...passthrough];
if (state.excludeTools.length)
  args.push("--exclude-tools", state.excludeTools.join(","));
const r = spawnSync("pi", args, {
  stdio: "inherit",
  env: { ...process.env, PI_CODING_AGENT_DIR: tmp },
});
process.exit(r.status ?? (r.error ? 1 : 0));

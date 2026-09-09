# piz --podman (krun microVM launch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `piz --podman` mode that launches pi inside a podman microVM (default runtime `krun`) using a filtered, copied config dir, plus a Dockerfile + GitHub Actions build so the image ships from GHCR — no local builds.

**Architecture:** piz already filters `settings.json` and knows every package's resolved path. New: (1) an image containing only the pi runtime + system tools; (2) a `materializeDir()` that *copies* `npm/` + `git/` + filtered settings into a temp dir (symlinks and hardlinks are both out: krun bind mounts can't dereference symlinks outside the mount, and `/tmp` is tmpfs vs home btrfs so hardlinks cross devices); (3) spawn `podman run` with the materialized dir at `/pi/agent` and `$PWD` at `/workspace`.

**Tech Stack:** Node (existing piz.mjs, stdlib only), Dockerfile (node:22-bookworm), GitHub Actions (GHCR push), podman + krun.

**Spec:** Design settled in-session (2026-09-09): image = runtime + tools only (git jq make gcc g++ python3-pip tree ripgrep gh, pi pinned 0.85.1); sandbox mode (no sessions mount, `--rm` disposable); `--network host` so the host llama-server is reachable; no ssh keys initially.

## Global Constraints

- pi version pin: `@earendil-works/pi-coding-agent@0.85.1` (matches host; bump in lockstep on `pi update`).
- Default image: `ghcr.io/jcpowermac/piz-pi:latest`, overridable with `--image`.
- Default VM runtime: `krun`, overridable with `--runtime` (e.g. `crun` for non-KVM machines).
- No new npm dependencies in piz.mjs (stdlib only).
- Mounts: materialized dir → `/pi/agent` (rw — pi writes run-history into its agent dir), `$PWD` → `/workspace` (rw). Suffix `:z` on both for SELinux.
- In-VM writes must never reach host files (real copies, not hardlinks — this is the security property).
- Commits: conventional-ish short subjects, one commit per step group as marked.

---

### Task 1: Dockerfile + GHCR build workflow

**Files:**
- Create: `Dockerfile` (repo root)
- Create: `.github/workflows/image.yml` (repo root)

**Interfaces:**
- Consumes: nothing.
- Produces: image `ghcr.io/jcpowermac/piz-pi` (tags `latest` + full sha), providing `pi` on PATH and the toolchain. Task 2's default image name relies on this exact name.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq make gcc g++ python3 python3-pip tree ripgrep gh \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @earendil-works/pi-coding-agent@0.85.1
WORKDIR /workspace
```

- [ ] **Step 2: Verify it builds locally**

Run: `podman build -t piz-pi:local .`
Expected: build succeeds; then `podman run --rm piz-pi:local pi --version` prints `0.85.1`.

- [ ] **Step 3: Write the GHCR workflow**

`.github/workflows/image.yml`:

```yaml
name: image
on:
  push:
    branches: [main]
  workflow_dispatch: {}
permissions:
  contents: read
  packages: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/piz-pi:latest
            ghcr.io/${{ github.repository_owner }}/piz-pi:${{ github.sha }}
```

- [ ] **Step 4: Push and verify the remote build**

```bash
git add Dockerfile .github/workflows/image.yml
git commit -m "piz: Dockerfile + GHCR build workflow"
git push
```

Watch: `gh run list --limit 3` → wait for `image` to pass. Then:
Run: `podman pull ghcr.io/jcpowermac/piz-pi:latest && podman run --rm ghcr.io/jcpowermac/piz-pi:latest pi --version`
Expected: `0.85.1`.
Known issue: if the push fails with 404/permission, create the package first (repo → Packages → Generate new package → container, public) and re-run.

---

### Task 2: `piz --podman` mode

**Files:**
- Modify: `piz.mjs` (flag parsing near line 22, new `materializeDir()` next to `makeConfigDir()` ~line 244, new podman branch in main flow after `--show` ~line 318, README note)
- Modify: `README.md` (usage section)

**Interfaces:**
- Consumes: existing `settings`, `pkgs`, `state`, `filteredPackages()`, `resolvedSrc()`, `passthrough` (all already in scope in piz.mjs main flow); Task 1's image name.
- Produces: `piz --podman [--image X] [--runtime Y] [--no-prompt] <pi args...>` — launches pi in the VM with the filtered config.

- [ ] **Step 1: Parse `--image` and `--runtime` out of argv**

Current parsing puts non-flag args into `passthrough`, so `--image foo` would leak `foo` to pi. Replace the `flags`/`passthrough` block (lines ~21-24) with:

```js
const SELF_FLAGS = new Set(["--show", "--no-prompt", "--selftest", "--podman"]);
let argv2 = process.argv.slice(2);
const flags = new Set(argv2.filter((a) => a.startsWith("--")));

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
const [DEFAULT_IMAGE, argv3] = ["ghcr.io/jcpowermac/piz-pi:latest", argv2];
const [image, argv4] = takeValue(argv3, "--image", DEFAULT_IMAGE);
const [runtime, passthrough] = takeValue(argv4, "--runtime", "krun");
```

(Collapses to: `const [image, a1] = takeValue(argv2, "--image", "ghcr.io/jcpowermac/piz-pi:latest"); const [runtime, passthrough] = takeValue(a1, "--runtime", "krun");` — `flags` still computed from `argv2` so `--image`/`--runtime` are harmless in it.)

- [ ] **Step 2: Add `materializeDir()` next to `makeConfigDir()`**

```js
// Real copies, not symlinks (krun can't deref symlinks outside the mount)
// and not hardlinks (in-VM writes would hit host files via the link; /tmp
// is tmpfs so cross-device hardlinks are impossible anyway).
function materializeDir(settings) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piz-vm-"));
  for (const d of ["npm", "git"]) {
    const src = path.join(AGENT_DIR, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, d), { recursive: true });
  }
  fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify(settings, null, 2));
  return tmp;
}
```

- [ ] **Step 3: Add the podman branch in the main flow**

Insert after the `--show` block, before the local `makeConfigDir` call:

```js
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
```

- [ ] **Step 4: Dry-run verification (no VM yet)**

Run: `node --check piz.mjs`
Expected: no syntax errors.
Run: `./piz --show --image foo --no-prompt | grep packages >/dev/null && echo ok`
Expected: `ok` (flags still parse, `--show` unaffected).

- [ ] **Step 5: End-to-end VM test**

Requires Task 1's image (or `-t piz-pi:local`). In a scratch git repo:

```bash
mkdir -p /tmp/piz-vm-test && cd /tmp/piz-vm-test && git init -q
piz --podman --image piz-pi:local --no-prompt -p "reply with exactly: VM-OK"
```

Expected: prints `VM-OK` (exactly), exit 0. This proves: krun boots, the copied config dir resolves (skills load), `--network host` reaches the llama-server model, workspace mounts at `/workspace`, `PI_CODING_AGENT_DIR` points at the mount.
If krun isn't set up yet: `podman run --runtime=krun --rm docker.io/library/alpine:3.20 echo ok` first; fix KVM (`/dev/kvm`, `kvm` group) before debugging piz.
Also confirm isolation: inside a failing/curious run, `ls /pi/agent` shows only `settings.json npm git` — no `sessions/`, `auth.json`, or `models.json`.

- [ ] **Step 6: Document in README**

In `README.md` usage section, after the existing flags:

```md
### MicroVM mode

    piz --podman [-p "prompt"]          # run pi in a krun microVM
    piz --podman --image IMG --runtime crun   # override image / runtime

Image (built by GitHub Actions on push to main): ghcr.io/jcpowermac/piz-pi
Only pi + tools live in the image; packages/skills are copied in at launch.
The VM shares the host network (needed for the local llama-server); the
workspace is mounted at /workspace, the filtered config at /pi/agent.
```

- [ ] **Step 7: Commit and push**

```bash
git add piz.mjs README.md
git commit -m "piz: --podman mode — launch pi in a krun microVM with a copied filtered config"
git push
```

---

## Self-Review Notes (already applied)

- Spec coverage: image contents (Task 1), no-local-build via GHCR (Task 1), copied materialized dir (Task 2 Step 2), mounts + network host + PI_CODING_AGENT_DIR (Step 3), image/runtime overrides (Step 1), KVM preflight (Step 3), docs (Step 6). Nothing in the settled design is unassigned.
- Deliberate skips (ponytail): no sessions mount (sandbox mode by decision), no ssh-key mount, no GH_TOKEN plumbing (spawnSync inherits the full env — works if the calling shell has it), no state.json entry for the image (flag + default suffices until a second image exists), no selftest case for materializeDir (thin `fs.cpSync` wrapper; Step 5 is the real test).

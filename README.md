# piz

Startup picker for [pi](https://github.com/badlogic/pi-mono) packages, skills,
and tools. Launches pi with a filtered config so you only pay the initial
context for what you actually want loaded.

Your real `~/.pi/agent/settings.json` is never modified — piz builds a
throwaway config dir, symlinks everything except `settings.json` into it,
writes a filtered `settings.json`, and execs pi with `PI_CODING_AGENT_DIR`
pointing at it.

## Install

```bash
alias piz=/home/jcallen/Development/piz/piz   # in .bashrc
```

or add `~/Development/piz` to your `PATH`.

## Usage

```bash
piz                  # picker, then pi (last selection pre-checked)
piz --no-prompt      # skip picker, reuse saved selection (also auto for non-TTY)
piz --show           # print the filtered settings.json that would be used
piz --selftest       # verify package resolution + filtering logic
piz <pi args...>     # everything else passes through to pi
```

Picker keys: `↑/↓` move · `space` toggle · `x` expand/collapse a package ·
`enter` done · `esc` cancel. After the package picker there is one
optional free-text line: comma-separated tool names passed to pi as
`--exclude-tools` (blank keeps the saved value).

## Selection model

- Each package from `packages` in settings.json is a row; toggling a package
  toggles it and all its skills.
- `x` expands a package to per-skill checkboxes (skills = dirs with a
  `SKILL.md` under the `pi.skills` manifest dirs).
- Fully selected packages stay as plain strings in the generated settings;
  partially selected ones use pi's documented object form
  `{"source": ..., "skills": [...]}`; deselected ones are dropped.

Selection persists in `~/.pi/piz/state.json`.

## MicroVM mode

```bash
piz --podman [-p "prompt"]              # run pi in a krun microVM
piz --podman --image IMG --runtime crun # override image / runtime
```

The image (built by GitHub Actions on push to main):
`ghcr.io/jcpowermac/piz-pi` — pi + tools only (git jq make gcc g++ python3
tree ripgrep gh). No packages live in the image: at launch piz copies
`npm/`, `git/`, and `models.json` from your agent dir plus the filtered
`settings.json` into a temp dir, and mounts it at `/pi/agent` with
`PI_CODING_AGENT_DIR` pointing at it. Your workspace is mounted at
`/workspace`. The VM shares the host network (so the local llama-server is
reachable); sessions/auth/models-store are NOT shared — the VM initializes
its own.

`~/.ssh` is mounted read-only at `/root/.ssh` (where container-ssh
resolves keys) and `$HOME/.ssh`, so git-over-SSH and `pi install git:`
work. Host env vars (e.g. `GH_TOKEN`) pass through automatically — podman,
unlike docker, inherits the caller's environment.

Needs: `krun` (dnf install krun), `/dev/kvm` (user in the `kvm` group),
and podman. Without KVM, retry with `--runtime crun` (no VM isolation).
Note: krun's host-net mode doesn't forward the host's DNS stub, so piz
passes `--dns 1.1.1.1`; reference tailnet services by IP, not hostname.

## Notes

- The temp config dir lives in `$TMPDIR` and is cleaned by the OS; sessions,
  auth, models, and installed packages are shared via symlinks.
- Run `pi install` / `pi update` with plain `pi`, not `piz`.
- Package resolution mirrors pi's: `npm:` → `~/.pi/agent/npm/node_modules/`,
  `git:` → `~/.pi/agent/git/`, anything else is a path relative to
  `~/.pi/agent` (or absolute).

#!/usr/bin/env bash
# Shared helpers for record worktree scripts.

WORKTREE_SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
RECORD_ROOT="$(dirname "$(dirname "$WORKTREE_SCRIPT_DIR")")"

worktree_die() {
  printf "\n  ✗ %s\n\n" "$1" >&2
  exit 1
}

resolve_worktree_dir() {
  local input="${1:-}"
  [[ -n "$input" ]] || worktree_die "Usage: <worktree-name|path>"

  if [[ "$input" == /* ]]; then
    printf '%s\n' "$input"
  elif [[ "$input" == .worktrees/* ]]; then
    printf '%s\n' "$RECORD_ROOT/$input"
  else
    printf '%s\n' "$RECORD_ROOT/.worktrees/$input"
  fi
}

cleanup_worktree_config() {
  local worktree_dir="$1"
  local wt_name="$(basename "$worktree_dir")"

  rm -rf "$HOME/.config/record/runtime/$wt_name"
  rm -rf "$HOME/.config/record/data/instances/$wt_name"
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    rm -rf "$XDG_CONFIG_HOME/record/runtime/$wt_name"
    rm -rf "$XDG_CONFIG_HOME/record/data/instances/$wt_name"
  fi

  git -C "$RECORD_ROOT" worktree prune >/dev/null 2>&1 || true
}

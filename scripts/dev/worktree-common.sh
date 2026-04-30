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

main_record_config_dir() {
  local worktree_dir="${1:-}"
  local candidate=""

  if [[ -n "${RECORD_MAIN_CONFIG_DIR:-}" ]]; then
    printf '%s\n' "$RECORD_MAIN_CONFIG_DIR"
    return 0
  fi

  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    candidate="$XDG_CONFIG_HOME/record"
    if [[ -d "$candidate" && "$candidate" != "$worktree_dir/config/record" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if [[ -n "${HOME:-}" ]]; then
    candidate="$HOME/.config/record"
    if [[ -d "$candidate" && "$candidate" != "$worktree_dir/config/record" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  return 1
}

sync_shared_config() {
  local worktree_dir="$1"
  local src_config=""
  local dest_home="$worktree_dir/config"
  local dest_config="$dest_home/record"
  local file=""

  src_config="$(main_record_config_dir "$worktree_dir" 2>/dev/null || true)"
  [[ -n "$src_config" ]] || return 0

  mkdir -p "$dest_config"
  chmod 700 "$dest_home" "$dest_config" 2>/dev/null || true

  # Copy secrets/config once so test worktrees can log in without mutating the
  # user's real ~/.config/record files. Existing worktree config wins.
  for file in config.json saved-logins.json; do
    if [[ -f "$src_config/$file" && ! -e "$dest_config/$file" ]]; then
      cp "$src_config/$file" "$dest_config/$file"
      chmod 600 "$dest_config/$file" 2>/dev/null || true
    fi
  done
}

cleanup_worktree_config() {
  local worktree_dir="$1"
  local wt_name="$(basename "$worktree_dir")"

  rm -rf "$worktree_dir/config"

  if [[ -n "${HOME:-}" ]]; then
    rm -rf "$HOME/.config/record/runtime/$wt_name"
    rm -rf "$HOME/.config/record/data/instances/$wt_name"
  fi
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    rm -rf "$XDG_CONFIG_HOME/record/runtime/$wt_name"
    rm -rf "$XDG_CONFIG_HOME/record/data/instances/$wt_name"
  fi

  git -C "$RECORD_ROOT" worktree prune >/dev/null 2>&1 || true
}

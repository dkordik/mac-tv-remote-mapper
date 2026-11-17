#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$(dirname "$0")"

# Prevent multiple instances from competing for the single CEC serial device.
pid_file="/tmp/cec-listener.pid"
supervisor_pid_file="/tmp/cec-listener-supervisor.pid"
# Optional, git-ignored KEY=value settings (e.g. CEC_AUDIO_SYSTEM=1). Re-read on every
# (re)launch, so edit it and run ./restart.sh to apply without retyping env vars.
env_file="${CEC_ENV_FILE:-.env.local}"
log_file="${CEC_LOG_FILE:-/tmp/cec-listener.log}"

if [[ -f "$supervisor_pid_file" ]]; then
  existing_pid="$(cat "$supervisor_pid_file" 2>/dev/null || true)"
  if [[ -n "${existing_pid}" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "cec-listener supervisor is already running (pid $existing_pid)." >&2
    exit 1
  fi
  rm -f "$supervisor_pid_file"
fi

child_pid=""
restart_requested=0
echo "$$" > "$supervisor_pid_file"

cleanup() {
  if [[ -f "$pid_file" ]]; then
    current_pid_file_value="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ "$current_pid_file_value" == "$child_pid" || -z "$current_pid_file_value" ]]; then
      rm -f "$pid_file"
    fi
  fi

  if [[ -f "$supervisor_pid_file" ]]; then
    current_supervisor_pid_file_value="$(cat "$supervisor_pid_file" 2>/dev/null || true)"
    if [[ "$current_supervisor_pid_file_value" == "$$" || -z "$current_supervisor_pid_file_value" ]]; then
      rm -f "$supervisor_pid_file"
    fi
  fi
}

forward_and_wait() {
  local signal="$1"
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "-$signal" "$child_pid" 2>/dev/null || true

    for _ in {1..20}; do
      if ! kill -0 "$child_pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done

    if kill -0 "$child_pid" 2>/dev/null; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  fi
}

trap 'restart_requested=1; forward_and_wait TERM' TERM
trap 'forward_and_wait INT; cleanup; exit 0' INT
trap 'forward_and_wait HUP; cleanup; exit 0' HUP
trap 'restart_requested=1; forward_and_wait TERM' USR1
trap 'cleanup' EXIT

while true; do
  restart_requested=0
  echo "=== cec-listener starting $(date '+%Y-%m-%d %H:%M:%S') ===" | tee -a "$log_file"
  if [[ -f "$env_file" ]]; then
    echo "Using settings from $env_file: $(grep -E '^[A-Za-z_]+=' "$env_file" | tr '\n' ' ')" | tee -a "$log_file"
  fi
  # Subshell keeps env-file values from leaking between restarts; exec keeps node's pid as $!.
  (
    set -a
    if [[ -f "$env_file" ]]; then
      # shellcheck disable=SC1090
      source "$env_file"
    fi
    set +a
    exec node index.js
  ) > >(tee -a "$log_file") 2>&1 &
  child_pid="$!"
  echo "$child_pid" > "$pid_file"

  exit_code=0
  if ! wait "$child_pid"; then
    exit_code=$?
  fi
  child_pid=""
  rm -f "$pid_file"

  if [[ "$restart_requested" -eq 1 ]]; then
    echo "Restarting cec-listener..."
    continue
  fi

  # 75 = self-restart requested by the running process (e.g. SIGUSR1).
  if [[ "$exit_code" -eq 75 ]]; then
    echo "Restarting cec-listener..."
    continue
  fi

  exit "$exit_code"
done

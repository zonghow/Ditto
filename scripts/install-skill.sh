#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN_DIR="${HOME}/.local/bin"
SKILL_SRC="${ROOT_DIR}/skills/ditto"
AGENTS_SKILL_DIR="${HOME}/.agents/skills/ditto"

mkdir -p "${BIN_DIR}"
install -m 0755 "${ROOT_DIR}/scripts/ditto" "${BIN_DIR}/ditto"

mkdir -p "${AGENTS_SKILL_DIR}"
cp -R "${SKILL_SRC}/." "${AGENTS_SKILL_DIR}/"

for agent_home in "${HOME}/.claude" "${HOME}/.codex" "${HOME}/.config/opencode"; do
  mkdir -p "${agent_home}/skills"
  rm -rf "${agent_home}/skills/ditto"
  ln -s "${AGENTS_SKILL_DIR}" "${agent_home}/skills/ditto"
done

echo "Installed CLI: ${BIN_DIR}/ditto"
echo "Installed Skill: ${AGENTS_SKILL_DIR}/SKILL.md"
echo "Linked Skill into ~/.claude/skills/ditto, ~/.codex/skills/ditto, and ~/.config/opencode/skills/ditto"

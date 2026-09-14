#!/usr/bin/env bash
# Apply / revert the dsh-worktree-session patch to the installed DSH package.
#
# The patch is TWO ANCHORED EDITS to @deepseek-ai/dsh-client-ui-workspace/lib/client.js
# (see make-patch.sh); all worktree logic lives in the dsh-worktree-session
# plugin (installed separately into the web profile). Safety:
#   - hash-guard: refuses to patch an unrecognized installed client.js
#   - own-artifact detection: every artifact this repo builds carries the
#     "dsh-worktree-session:patch" marker, so a stale patch of ours can be
#     upgraded in place while a genuine upstream change is left alone
#   - the badge's seam patch composes: the pristine baseline this patch targets
#     INCLUDES the dsh-git-badge seam (they touch disjoint regions)
#
# Usage: apply.sh apply | apply.sh revert | apply.sh status
#
# `status` inspects the installed package without touching it and exits 0 for a
# recognised state, 1 for drift — the first thing to run after a DSH update.
set -euo pipefail

DSH="${DSH_INSTALL:-$HOME/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh}"
PKG="$DSH/node_modules/@deepseek-ai/dsh-client-ui-workspace"
HERE="$(cd "$(dirname "$0")" && pwd)"

# sha256 of the installed lib/client.js this patch was built against (the
# upstream build PLUS the dsh-git-badge seam patch — the two compose).
PRISTINE_HASH="$(cut -d' ' -f1 "$HERE/pristine.sha256")"
CLIENT="$PKG/lib/client.js"

MARKER="dsh-worktree-session:patch"
BADGE_MARKER="dsh-git-badge:seam-patch"

current_hash() { sha256sum "$CLIENT" | cut -d' ' -f1; }
artifact_hash() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || true; }
has_marker() { grep -q "$MARKER" "$1" 2>/dev/null; }

PATCHED_HASH="$(artifact_hash "$HERE/patched-client.js")"

case "${1:?usage: apply.sh apply|revert|status}" in
apply)
	CUR="$(current_hash)"
	if [ "$CUR" = "$PATCHED_HASH" ]; then
		echo "installed client.js is already this repo's current patch — nothing to do."
	elif has_marker "$CLIENT" || [ "$CUR" = "$PRISTINE_HASH" ]; then
		# The backup is the baseline this patch targets (badge seam included), not
		# the bytes being replaced — reverting must land back on a known state.
		cp "$HERE/pristine-client.js" "$HERE/backup-client.js"
		cp "$HERE/patched-client.js" "$CLIENT"
		echo "applied worktree-session patch. restart the dsh web process to pick it up."
	else
		echo "REFUSING: installed client.js hash $CUR is neither the pristine baseline" >&2
		echo "this patch targets ($PRISTINE_HASH) nor an artifact carrying the" >&2
		echo "\"$MARKER\" marker. Upstream (or the badge patch) changed;" >&2
		echo "rebuild the patch first:" >&2
		echo "  cp \"$CLIENT\" \"$HERE/pristine-client.js\" && sha256sum \"$CLIENT\" | cut -d' ' -f1 > \"$HERE/pristine.sha256\" && ./make-patch.sh" >&2
		exit 1
	fi
	;;
revert)
	if has_marker "$CLIENT"; then
		if [ -f "$HERE/backup-client.js" ]; then
			cp "$HERE/backup-client.js" "$CLIENT"
			echo "reverted to the baseline (badge seam included). restart the dsh web process."
		else
			cp "$HERE/pristine-client.js" "$CLIENT"
			echo "reverted to the pristine baseline. restart the dsh web process."
		fi
	else
		echo "installed client.js carries no dsh-worktree-session patch — nothing to revert."
	fi
	;;
status)
	CUR="$(current_hash)"
	echo "installed: $CUR"
	echo "pristine:  $PRISTINE_HASH"
	echo "patched:   ${PATCHED_HASH:-<patched-client.js not built>}"
	if has_marker "$CLIENT"; then
		echo "state: patched (dsh-worktree-session artifact present)"
	elif [ "$CUR" = "$PRISTINE_HASH" ]; then
		echo "state: pristine baseline (badge seam present, no worktree patch)"
	else
		echo "state: DRIFT — unknown build; the apply guard will refuse. rebuild the patch."
		exit 1
	fi
	;;
esac

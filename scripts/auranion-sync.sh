#!/usr/bin/env bash
set -euo pipefail

# ponytail: one pending upstream PR; resolve/merge it before queueing another.
# No rebases, force pushes, automatic merges, or production deployment.
repo=${GITHUB_REPOSITORY:-KhasVN/9router}
[[ "$repo" == KhasVN/9router ]] || { echo 'Unexpected destination repository'; exit 1; }
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git fetch origin master auranion
git fetch https://github.com/decolua/9router.git master
upstream=$(git rev-parse FETCH_HEAD)
git merge-base --is-ancestor origin/master "$upstream" || {
  echo 'Upstream rewrote history or mirror contains local commits; manual review required.'
  exit 1
}
git push origin "$upstream:refs/heads/master"
if git merge-base --is-ancestor "$upstream" origin/auranion; then
  echo 'Maintenance branch already includes upstream.'
  exit 0
fi
pending=$(gh pr list --repo "$repo" --base auranion --state open --json headRefName,url \
  --jq '[.[] | select(.headRefName | startswith("sync/upstream-")) | .url][0] // empty')
if [[ -n "$pending" ]]; then
  echo "Review pending upstream PR: $pending"
  exit 0
fi
branch="sync/upstream-${upstream:0:12}"
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch origin "$branch"
  git switch --detach FETCH_HEAD
else
  git switch -c "$branch" origin/auranion
  if ! git merge --no-ff --no-edit "$upstream"; then
    git merge --abort
    # Preserve the conflicting upstream tip; GitHub exposes conflicts against auranion.
    git switch --detach "$upstream"
    git push origin "HEAD:refs/heads/$branch"
    gh pr create --repo "$repo" --base auranion --head "$branch" --draft \
      --title "chore(upstream): resolve merge conflicts at ${upstream:0:12}" \
      --body "Upstream merge conflicts. Resolve on this branch before review. No fixes were overwritten. Container checks must pass after resolution."
    echo 'Upstream merge conflicts require manual resolution.'
    exit 1
  fi
  git push origin "HEAD:refs/heads/$branch"
fi
gh pr create --repo "$repo" --base auranion --head "$branch" \
  --title "chore(upstream): merge ${upstream:0:12}" \
  --body "Merges decolua/9router master without rewriting downstream commits. Review protocol changes and the container checks before merging. No automatic merge or deployment."
# Explicit dispatch ensures bot-created PRs receive checks despite token event suppression.
gh workflow run auranion-ci.yml --repo "$repo" --ref "$branch"

# We want to add a new framing toggle which should wipe out all other framing. Should be setting somew

## Context

- Product: zeevee
- Repository: ColemanIsner/zeevee

## Intent

We want to add a new framing toggle which should wipe out all other framing. Should be setting somewhere clean. 

Portrait orientation, but the actual video shoupd be square and aligned with the top of the portrait view. Simple button click with basic remotion settings. No AI needed.

## Scope

Implement the smallest coherent change that satisfies the intent. Inspect the repository before changing code and record material assumptions in the final result.

## Constraints

- Preserve existing behavior outside this mission.
- Do not bypass product deploy policy or safety gates.

## Acceptance criteria

- Run the repository's documented static checks.
- Run the relevant automated tests.
- Run a production build when the repository supports one.
- Confirm a pull request exists from the mission branch into the default branch.
- Do not merge or deploy — human gate product. Leave the PR open for the operator; confirm it is mergeable and cite the PR URL.
- Report exact commands, outputs, PR URL, and any skipped checks.

## Out of scope

- Unrelated refactors or product work.
- Deploying across a human gate.
---
title: Canonical library model
description: Understand groups, qualified skill IDs, validation, and Git ownership.
---

The canonical library is an ordinary Git repository with a small metadata boundary and a validated skill tree.

```text
.skill-sync/
  library.json
skills/
  format-code/
    SKILL.md
  frontend/
    .skill-sync-group.json
    review-ui/
      SKILL.md
      references/
      scripts/
```

## Skills are leaves

Directories below `skills/` are interpreted as groups until a directory containing `SKILL.md` is found. That directory is a skill leaf; directories beneath it are part of that skill and cannot become nested skill roots.

The complete relative path is the qualified skill ID. In the example above, the IDs are `format-code` and `frontend/review-ui`.

- Group and skill names must be lowercase and portable across supported filesystems.
- Duplicate leaf names can exist in different groups.
- An unqualified selector such as `review-ui` works only when it resolves uniquely.
- Explicit group markers preserve an empty group after its final skill is removed.

## The library is validated as a whole

Before a canonical write, `skill-sync` validates the complete proposed tree. It rejects malformed front matter, unsafe or case-colliding paths, symlinks, special files, nested Git repositories, nested skill roots, and traversal outside the expected directory.

Validation reads content but does not execute it. Use the same validator directly:

```sh
skill-sync validate
skill-sync validate frontend/review-ui
skill-sync validate ./local-skill
```

## Git is the version and recovery layer

The configured remote and branch define the canonical history. Mutating commands work from a clean exact-revision checkout, validate the proposed result, create a normal commit, and push without force. If another writer changes touched content first, the operation stops rather than overwriting the newer commit.

Git history is also the recovery path for canonical deletions. `skill-sync` does not replace repository access controls: use private visibility, restricted credentials, branch protection, and required checks when the library needs stronger enforcement.

See [library workflows](/guides/library-workflows/) for creation and mutation commands.

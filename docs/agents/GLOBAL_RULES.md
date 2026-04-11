# Agent Global Rules

Rules every agent MUST follow. No exceptions, no skipping.

## 1. Commit Before Destruction

Before removing or replacing >10 lines of code, commit the current working state first.
Before starting any structural refactor, commit first.
A stray `git checkout` must never destroy hours of work.

## 2. Log Your Work

After completing any meaningful unit of work, append to `docs/agents/WORK_LOG.md`:
```
## YYYY-MM-DD HH:MM — [agent-name]
**Action:** What was done (one line)
**Reasoning:** Why this approach, what alternatives were considered (2-3 lines max)
**Commit:** <hash> or "uncommitted"
**Files touched:** list of paths
```

## 3. Log Errors

When something fails unexpectedly (wrong assumption, broken approach, runtime error), append to `docs/agents/ERROR_LOG.md`:
```
## YYYY-MM-DD HH:MM — [agent-name]
**Error:** What went wrong (one line)
**Context:** What was being attempted
**Root cause:** Why it failed (if known)
**Resolution:** How it was fixed, or "unresolved"
**Lesson:** What future agents should know to avoid this
```

## 4. Update Your File Map on Exit

Before finishing a session, if you changed files in your domain:
- Update your `FILE_MAP.md` with current line counts, exports, and git hash
- If you touched files outside your domain, note it in the work log so the owning agent knows

## 5. Check Map Staleness on Entry

When starting work, read your `FILE_MAP.md`. Compare its `git_hash` against:
```
git log --oneline <git_hash>..HEAD -- <your domain paths>
```
If commits exist that touched your domain since your last map update, do a targeted re-scan of only the changed files before proceeding.

## 6. Stay In Your Lane

Each agent has a defined domain (directories + file patterns). If your task requires changing files outside your domain:
- Do it if it's minor (< 5 lines, e.g. an import fix)
- For anything larger, note it in the work log as a handoff to the owning agent

## 7. Read Before Edit

Never modify a file you haven't read in the current session. No blind edits based on memory or maps alone.

## 8. Skill Invocation

When dispatched as a subagent with a specific task, skip skill checks and execute directly.
When invoked interactively, follow the skill protocol.

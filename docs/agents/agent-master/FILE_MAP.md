# Agent Master — File Map

**git_hash:** (pending — set after first commit)
**last_updated:** 2026-04-11

## Domain

The agent-master's domain is the agent infrastructure itself:

```
docs/agents/
├── GLOBAL_RULES.md              # Shared rules all agents follow
├── WORK_LOG.md                  # Append-only structured log
├── ERROR_LOG.md                 # Error patterns and lessons
├── agent-master/
│   ├── FILE_MAP.md              # This file
│   └── MEMORY.md               # Master agent memory
├── format-maint/
│   ├── FILE_MAP.md              # Parser domain map
│   └── MEMORY.md               # Parser consistency findings
├── issue-triage/
│   ├── FILE_MAP.md              # Repo info, issue snapshot, labels
│   └── MEMORY.md               # Issue patterns, tester profiles, triage decisions
├── backend/
│   ├── FILE_MAP.md
│   └── MEMORY.md
├── renderer/
│   ├── FILE_MAP.md
│   └── MEMORY.md
├── ui/
│   ├── FILE_MAP.md
│   └── MEMORY.md
├── pdf/
│   ├── FILE_MAP.md
│   └── MEMORY.md
├── devops/
│   ├── FILE_MAP.md
│   └── MEMORY.md
└── qa/
    ├── FILE_MAP.md
    └── MEMORY.md
```

## Agent Registry

| Agent | Domain Directories | Status |
|-------|--------------------|--------|
| format-maint | `src/frontend/src/parsers/`, `docs/formats/` | Active — skill + map + memory created |
| issue-triage | GitHub Issues, beta feedback, `docs/agents/issue-triage/` | Active — skill + map + memory created |
| backend | `src/backend/`, `Board Database/` | Planned — directory created |
| renderer | `src/frontend/src/renderer/` | Planned — directory created |
| ui | `src/frontend/src/panels/`, `components/`, `hooks/`, `store/` | Planned — directory created |
| pdf | `src/frontend/src/pdf/`, `panels/PdfViewerPanel.tsx`, `store/pdf-store.ts` | Planned — directory created |
| devops | `Dockerfile`, `.github/`, `desktop/`, `scripts/` | Planned — directory created |
| qa | `src/frontend/tests/`, `src/backend/**_test.go` | Planned — directory created |

## Skill Locations

| Agent | Skill Path |
|-------|-----------|
| agent-master | `~/.claude/skills/boardripper-agent-master/skill.md` |
| format-maint | `~/.claude/skills/boardripper-format-maint/skill.md` |
| issue-triage | `~/.claude/skills/boardripper-issue-triage/skill.md` |

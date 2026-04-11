# Agent Master — File Map

**git_hash:** a7bbb79
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
| backend | `src/backend/`, `Board Database/` | Active — skill + map + memory created |
| renderer | `src/frontend/src/renderer/` | Active — skill + map + memory created |
| ui | `src/frontend/src/panels/`, `components/`, `hooks/`, `store/` | Active — skill + map + memory created |
| pdf | `src/frontend/src/pdf/`, `panels/PdfViewerPanel.tsx`, `store/pdf-store.ts` | Active — skill + map + memory created |
| devops | `Dockerfile`, `.github/`, `desktop/`, `scripts/` | Active — skill + map + memory created |
| qa | `src/frontend/tests/`, `src/backend/**_test.go` | Active — skill + map + memory created |

## Skill Locations

| Agent | Skill Path |
|-------|-----------|
| agent-master | `~/.claude/skills/boardripper-agent-master/skill.md` |
| format-maint | `~/.claude/skills/boardripper-format-maint/skill.md` |
| issue-triage | `~/.claude/skills/boardripper-issue-triage/skill.md` |
| backend | `~/.claude/skills/boardripper-backend/skill.md` |
| renderer | `~/.claude/skills/boardripper-renderer/skill.md` |
| ui | `~/.claude/skills/boardripper-ui/skill.md` |
| pdf | `~/.claude/skills/boardripper-pdf/skill.md` |
| devops | `~/.claude/skills/boardripper-devops/skill.md` |
| qa | `~/.claude/skills/boardripper-qa/skill.md` |

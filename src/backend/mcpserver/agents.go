package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const agentsFile = "mcp-agents.json"

// Agent is one connected assistant as Settings ▸ Integrations shows it: a
// client program (its MCP clientInfo name) reached through one credential. The
// same Cursor on two browsers is two agents, because each browser's pairing
// token is a different credential with a different reach.
type Agent struct {
	Key        string    `json:"key"`
	Name       string    `json:"name"`              // clientInfo.title, else .name
	ClientName string    `json:"client_name"`       // clientInfo.name, stable
	Version    string    `json:"version,omitempty"` // clientInfo.version
	Credential string    `json:"credential"`        // browser | shared | oauth | assistant
	BrowserID  string    `json:"browser_id,omitempty"`
	FirstSeen  time.Time `json:"first_seen"`
	LastSeen   time.Time `json:"last_seen"`
	LastTool   string    `json:"last_tool,omitempty"`
	Calls      int64     `json:"calls"`
	// Drive overrides the install-wide "Allow agents to control the UI" for
	// this agent: nil follows the global switch.
	Drive *bool `json:"drive,omitempty"`
	// Blocked agents get an error on every request until allowed again.
	Blocked bool `json:"blocked,omitempty"`
}

// AgentRegistry records which assistants have connected and holds their
// per-agent permissions. Persisted to <dataDir>/mcp-agents.json so the list
// and the switches survive a restart; activity is written at most every 10 s.
type AgentRegistry struct {
	mu        sync.Mutex
	path      string
	byKey     map[string]*Agent
	dirty     bool
	lastWrite time.Time
}

// LoadAgents reads the registry (a missing or unreadable file starts empty —
// this is a convenience list, not a credential store). dataDir "" keeps it in
// memory only (tests).
func LoadAgents(dataDir string) *AgentRegistry {
	ar := &AgentRegistry{byKey: map[string]*Agent{}}
	if dataDir == "" {
		return ar
	}
	ar.path = filepath.Join(dataDir, agentsFile)
	b, err := os.ReadFile(ar.path)
	if err != nil {
		return ar
	}
	var file struct {
		Agents []*Agent `json:"agents"`
	}
	if json.Unmarshal(b, &file) == nil {
		for _, a := range file.Agents {
			if a != nil && a.Key != "" {
				ar.byKey[a.Key] = a
			}
		}
	}
	return ar
}

// agentKey identifies an agent by credential and client name.
func agentKey(sc Scope, clientName string) string {
	cred := sc.credential()
	id := sc.ClientID
	if id == "" {
		id = "-"
	}
	return cred + ":" + id + "|" + strings.ToLower(strings.TrimSpace(clientName))
}

func (sc Scope) credential() string {
	switch {
	case sc.Kind != "":
		return sc.Kind
	case sc.ClientID != "":
		return "browser"
	default:
		return "shared"
	}
}

// touch records one request from an agent and returns its current record
// (a copy). tool is "" for non-tool methods.
func (ar *AgentRegistry) touch(sc Scope, info *mcp.Implementation, tool string) Agent {
	name, title, version := "unknown client", "", ""
	if info != nil {
		if info.Name != "" {
			name = info.Name
		}
		title, version = info.Title, info.Version
	}
	key := agentKey(sc, name)
	now := nowFunc()
	ar.mu.Lock()
	defer ar.mu.Unlock()
	a := ar.byKey[key]
	if a == nil {
		a = &Agent{Key: key, ClientName: name, Credential: sc.credential(), BrowserID: sc.ClientID, FirstSeen: now}
		ar.byKey[key] = a
		ar.dirty = true
	}
	a.Name = title
	if a.Name == "" {
		a.Name = name
	}
	a.Version = version
	a.LastSeen = now
	if tool != "" {
		a.LastTool = tool
		a.Calls++
	}
	ar.dirty = true
	ar.maybePersistLocked(false)
	return *a
}

// DriveAllowed resolves the drive permission for the agent in ctx: its own
// override when set, else the global switch.
func (ar *AgentRegistry) DriveAllowed(ctx context.Context, global bool) bool {
	key, _ := ctx.Value(agentCtxKey{}).(string)
	if ar == nil || key == "" {
		return global
	}
	ar.mu.Lock()
	defer ar.mu.Unlock()
	if a := ar.byKey[key]; a != nil && a.Drive != nil {
		return *a.Drive
	}
	return global
}

// List returns every agent, most recently seen first.
func (ar *AgentRegistry) List() []Agent {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	out := make([]Agent, 0, len(ar.byKey))
	for _, a := range ar.byKey {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

// AgentUpdate is a partial change from Settings. Drive: "on" | "off" | "default".
type AgentUpdate struct {
	Drive   *string `json:"drive,omitempty"`
	Blocked *bool   `json:"blocked,omitempty"`
	Forget  bool    `json:"forget,omitempty"`
}

var errNoAgent = errors.New("no such agent")

// Update applies a Settings change and writes it through.
func (ar *AgentRegistry) Update(key string, u AgentUpdate) error {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	a := ar.byKey[key]
	if a == nil {
		return errNoAgent
	}
	if u.Forget {
		delete(ar.byKey, key)
	} else {
		if u.Drive != nil {
			switch *u.Drive {
			case "on":
				t := true
				a.Drive = &t
			case "off":
				f := false
				a.Drive = &f
			default:
				a.Drive = nil
			}
		}
		if u.Blocked != nil {
			a.Blocked = *u.Blocked
		}
	}
	ar.dirty = true
	ar.maybePersistLocked(true)
	return nil
}

func (ar *AgentRegistry) blocked(key string) bool {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	a := ar.byKey[key]
	return a != nil && a.Blocked
}

func (ar *AgentRegistry) maybePersistLocked(force bool) {
	if ar.path == "" || !ar.dirty {
		return
	}
	if !force && nowFunc().Sub(ar.lastWrite) < 10*time.Second {
		return
	}
	list := make([]*Agent, 0, len(ar.byKey))
	for _, a := range ar.byKey {
		list = append(list, a)
	}
	b, err := json.MarshalIndent(struct {
		Agents []*Agent `json:"agents"`
	}{list}, "", "  ")
	if err != nil {
		return
	}
	tmp := ar.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil && os.Rename(tmp, ar.path) == nil {
		ar.dirty = false
		ar.lastWrite = nowFunc()
	}
}

type agentCtxKey struct{}

// blockedMessage is what a disconnected agent sees on every request.
const blockedMessage = "This assistant was disconnected in BoardRipper (Settings ▸ Integrations ▸ Connected assistants). Allow it again there to reconnect."

// agentMiddleware records every request against its agent, refuses blocked
// agents, filters the tool list by the scope's tool groups, and puts the agent
// key in the context so per-agent permissions can be resolved by the tools.
func agentMiddleware(ar *AgentRegistry) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			sc := ScopeFrom(ctx)
			var info *mcp.Implementation
			if method == "initialize" {
				if r, ok := req.(*mcp.InitializeRequest); ok && r.Params != nil {
					info = r.Params.ClientInfo
				}
			} else if ss, ok := req.GetSession().(*mcp.ServerSession); ok && ss != nil {
				if p := ss.InitializeParams(); p != nil {
					info = p.ClientInfo
				}
			}
			tool := ""
			if method == "tools/call" {
				if r, ok := req.(*mcp.CallToolRequest); ok && r.Params != nil {
					tool = r.Params.Name
					if !sc.allowsTool(tool) {
						return nil, errors.New("tool " + tool + " is not in this connection's tool groups (see the ?tools= part of the server URL)")
					}
				}
			}
			// Only the requests that say something about the agent are recorded;
			// notifications (e.g. notifications/initialized) can arrive before
			// the session holds its client info.
			track := method == "initialize" || method == "tools/call" || method == "tools/list"
			if ar != nil && track && info != nil {
				a := ar.touch(sc, info, tool)
				if a.Blocked && method != "initialize" {
					return nil, errors.New(blockedMessage)
				}
				ctx = context.WithValue(ctx, agentCtxKey{}, a.Key)
			}
			res, err := next(ctx, method, req)
			if method == "tools/list" && err == nil {
				if lr, ok := res.(*mcp.ListToolsResult); ok && lr != nil {
					kept := lr.Tools[:0:0]
					for _, t := range lr.Tools {
						if sc.allowsTool(t.Name) {
							kept = append(kept, t)
						}
					}
					lr.Tools = kept
				}
			}
			return res, err
		}
	}
}

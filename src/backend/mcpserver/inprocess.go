package mcpserver

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// AssistantClientName is the clientInfo name the built-in assistant uses, so
// it shows up in Settings ▸ Integrations ▸ Connected assistants like any
// other agent.
const AssistantClientName = "BoardRipper assistant"

// ConnectAssistant opens an in-process MCP client session for the built-in
// assistant, scoped to one paired browser: live tools reach only that
// browser's pages. Kind "assistant" is never produced by GateAuto, so only
// this in-process path can carry it; the assistant loop asks the user before
// any tool that changes something, which is why the drive gate lets it pass.
func (s *Server) ConnectAssistant(ctx context.Context, browserID string) (*mcp.ClientSession, func(), error) {
	sctx := withScope(ctx, Scope{ClientID: browserID, Kind: "assistant"})
	ct, st := mcp.NewInMemoryTransports()
	ss, err := s.mcp.Connect(sctx, st, nil)
	if err != nil {
		return nil, nil, err
	}
	c := mcp.NewClient(&mcp.Implementation{Name: AssistantClientName, Title: AssistantClientName, Version: "1"}, nil)
	cs, err := c.Connect(ctx, ct, nil)
	if err != nil {
		ss.Close()
		return nil, nil, err
	}
	return cs, func() { cs.Close(); ss.Close() }, nil
}

// AssistantAgentKey is the Connected-assistants key of a browser's built-in
// assistant.
func AssistantAgentKey(browserID string) string {
	return agentKey(Scope{ClientID: browserID, Kind: "assistant"}, AssistantClientName)
}

// DriveAllowedFor resolves the drive permission of the agent with key.
func (ar *AgentRegistry) DriveAllowedFor(key string, global bool) bool {
	return ar.DriveAllowed(context.WithValue(context.Background(), agentCtxKey{}, key), global)
}

// ToolGroupOf and IsMutatingTool expose the tool table to the assistant.
func ToolGroupOf(name string) string { return toolGroup[name] }
func IsMutatingTool(name string) bool { return mutatingTools[name] }

// Instructions is the server-level orientation every MCP client receives;
// the built-in assistant puts it in its system prompt.
func Instructions() string { return technicianPersona + "\n\n" + boardripperInstructions }

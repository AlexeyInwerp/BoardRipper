// Package assistant runs BoardRipper's built-in AI assistant: a chat that
// answers with the same tools the MCP server offers, using a model provider
// the user configured with their own API key or a local model server.
//
// Every route is one the provider documents for third-party apps (an API key
// or a self-hosted model). Subscriptions to Claude, Gemini and similar are
// deliberately not supported here; those are used by connecting the vendor's
// own app over MCP instead. Design: docs/specs/2026-11-11-ai-toolkit.html.
//
// Keys belong to one paired browser (the MCP pairing client id) and are
// never sent back to a browser: on a NAS several people share one install,
// and one person's key must not answer another person's requests.
package assistant

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const settingsFile = "assistant.json"

// Provider describes one supported model source.
type Provider struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Kind     string `json:"kind"` // anthropic | openai (OpenAI-compatible chat completions)
	BaseURL  string `json:"base_url"`
	NeedsKey bool   `json:"needs_key"`
	Local    bool   `json:"local"`   // runs on the user's network; nothing leaves it
	Images   bool   `json:"images"`  // send tool images (board snapshots, PDF pages)
	Default  string `json:"default"` // default model id, "" = pick from the list
	KeyURL   string `json:"key_url,omitempty"`
}

// Providers is the fixed list, in the order the panel offers them.
var Providers = []Provider{
	{ID: "anthropic", Label: "Anthropic (Claude)", Kind: "anthropic", BaseURL: "https://api.anthropic.com", NeedsKey: true, Images: true, Default: "claude-opus-5-5", KeyURL: "https://platform.claude.com/settings/keys"},
	{ID: "openai", Label: "OpenAI", Kind: "openai", BaseURL: "https://api.openai.com/v1", NeedsKey: true, Images: true, KeyURL: "https://platform.openai.com/api-keys"},
	{ID: "google", Label: "Google (Gemini API)", Kind: "openai", BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai", NeedsKey: true, Images: true, KeyURL: "https://aistudio.google.com/apikey"},
	{ID: "ollama", Label: "Ollama (local)", Kind: "openai", BaseURL: "http://localhost:11434/v1", Local: true},
	{ID: "lmstudio", Label: "LM Studio (local)", Kind: "openai", BaseURL: "http://localhost:1234/v1", Local: true},
}

func providerByID(id string) (Provider, bool) {
	for _, p := range Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// ProviderConfig is one browser's settings for one provider.
type ProviderConfig struct {
	APIKey  string `json:"api_key,omitempty"`
	BaseURL string `json:"base_url,omitempty"`
	Model   string `json:"model,omitempty"`
}

// BrowserSettings is everything one paired browser configured.
type BrowserSettings struct {
	Active    string                     `json:"active,omitempty"`
	WebSearch *bool                      `json:"web_search,omitempty"` // nil = on
	Providers map[string]*ProviderConfig `json:"providers,omitempty"`
}

// Store persists BrowserSettings per browser to <dataDir>/assistant.json (0600).
type Store struct {
	mu   sync.Mutex
	path string
	data map[string]*BrowserSettings
}

// LoadStore reads the settings file; a missing file starts empty, a corrupt
// one is an error (the operator can delete it).
func LoadStore(dataDir string) (*Store, error) {
	s := &Store{data: map[string]*BrowserSettings{}}
	if dataDir == "" {
		return s, nil
	}
	s.path = filepath.Join(dataDir, settingsFile)
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) persistLocked() error {
	if s.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// get returns a copy of a browser's settings.
func (s *Store) get(browser string) BrowserSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	bs := s.data[browser]
	if bs == nil {
		return BrowserSettings{Providers: map[string]*ProviderConfig{}}
	}
	out := BrowserSettings{Active: bs.Active, WebSearch: bs.WebSearch, Providers: map[string]*ProviderConfig{}}
	for k, v := range bs.Providers {
		c := *v
		out.Providers[k] = &c
	}
	return out
}

// ConfigChange is a partial update from the panel. Empty strings leave a
// field alone; ClearKey removes the stored key.
type ConfigChange struct {
	Provider  string `json:"provider"`
	APIKey    string `json:"api_key,omitempty"`
	ClearKey  bool   `json:"clear_key,omitempty"`
	BaseURL   string `json:"base_url,omitempty"`
	Model     string `json:"model,omitempty"`
	Activate  bool   `json:"activate,omitempty"`
	WebSearch *bool  `json:"web_search,omitempty"`
}

func (s *Store) apply(browser string, c ConfigChange) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bs := s.data[browser]
	if bs == nil {
		bs = &BrowserSettings{Providers: map[string]*ProviderConfig{}}
		s.data[browser] = bs
	}
	if bs.Providers == nil {
		bs.Providers = map[string]*ProviderConfig{}
	}
	if c.WebSearch != nil {
		v := *c.WebSearch
		bs.WebSearch = &v
	}
	if c.Provider != "" {
		if _, ok := providerByID(c.Provider); !ok {
			return errors.New("unknown provider")
		}
		pc := bs.Providers[c.Provider]
		if pc == nil {
			pc = &ProviderConfig{}
			bs.Providers[c.Provider] = pc
		}
		if k := strings.TrimSpace(c.APIKey); k != "" {
			pc.APIKey = k
		}
		if c.ClearKey {
			pc.APIKey = ""
		}
		if u := strings.TrimSpace(c.BaseURL); u != "" {
			pc.BaseURL = strings.TrimRight(u, "/")
		}
		if m := strings.TrimSpace(c.Model); m != "" {
			pc.Model = m
		}
		if c.Activate {
			bs.Active = c.Provider
		}
	}
	return s.persistLocked()
}

// resolved is a provider ready to call.
type resolved struct {
	Provider
	APIKey string
	Model  string
}

func (s *Store) resolve(browser, providerID string) (resolved, error) {
	bs := s.get(browser)
	if providerID == "" {
		providerID = bs.Active
	}
	p, ok := providerByID(providerID)
	if !ok {
		return resolved{}, errors.New("choose a model provider in the assistant's settings first")
	}
	r := resolved{Provider: p, Model: p.Default}
	if pc := bs.Providers[p.ID]; pc != nil {
		r.APIKey = pc.APIKey
		if pc.BaseURL != "" {
			r.BaseURL = pc.BaseURL
		}
		if pc.Model != "" {
			r.Model = pc.Model
		}
	}
	if p.NeedsKey && r.APIKey == "" {
		return resolved{}, errors.New("add your " + p.Label + " API key in the assistant's settings first")
	}
	if r.Model == "" {
		return resolved{}, errors.New("choose a model in the assistant's settings first")
	}
	return r, nil
}

func (s *Store) webSearch(browser string) bool {
	bs := s.get(browser)
	return bs.WebSearch == nil || *bs.WebSearch
}

// PublicConfig is what the panel sees: never a key, only whether one is set.
type PublicConfig struct {
	Active    string           `json:"active"`
	WebSearch bool             `json:"web_search"`
	Providers []PublicProvider `json:"providers"`
}

type PublicProvider struct {
	Provider
	HasKey  bool   `json:"has_key"`
	KeyHint string `json:"key_hint,omitempty"` // last 4 characters
	Model   string `json:"model"`
}

func (s *Store) public(browser string) PublicConfig {
	bs := s.get(browser)
	out := PublicConfig{Active: bs.Active, WebSearch: bs.WebSearch == nil || *bs.WebSearch}
	for _, p := range Providers {
		pp := PublicProvider{Provider: p, Model: p.Default}
		if pc := bs.Providers[p.ID]; pc != nil {
			if pc.APIKey != "" {
				pp.HasKey = true
				if n := len(pc.APIKey); n > 8 {
					pp.KeyHint = pc.APIKey[n-4:]
				}
			}
			if pc.BaseURL != "" {
				pp.BaseURL = pc.BaseURL
			}
			if pc.Model != "" {
				pp.Model = pc.Model
			}
		}
		out.Providers = append(out.Providers, pp)
	}
	return out
}

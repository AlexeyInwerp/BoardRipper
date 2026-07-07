package mcpserver

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"html"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
)

// OAuth is a minimal embedded OAuth 2.1 authorization server + resource-server
// verifier for the MCP endpoint (Sub-project C, Approach A). It implements just
// enough for MCP clients: protected-resource + AS metadata discovery, dynamic
// client registration (RFC 7591), authorization-code with PKCE (S256), and an
// opaque-token endpoint. Tokens are opaque and stored in-memory (the same
// process issues and verifies them), so there is no JWT/JWKS machinery and
// tokens simply expire on restart — clients re-authorize transparently.
//
// Trust model: like /api/mcp/token, the consent screen is unauthenticated and
// assumes a trusted LAN/Docker deployment (the operator is the one connecting).
// For exposed/multi-user use, gate the consent screen behind a login — tracked
// in the design doc.
type OAuth struct {
	scope string

	mu      sync.Mutex
	clients map[string]*oauthClient
	codes   map[string]*authCode
	tokens  map[string]*accessToken
}

type oauthClient struct {
	ID           string
	Name         string
	RedirectURIs []string
	createdAt    time.Time
	lastUsed     time.Time // touched on each authorize; drives LRU eviction + sweep
}

type authCode struct {
	clientID    string
	redirectURI string
	challenge   string // PKCE code_challenge (S256)
	scope       string
	expiry      time.Time
}

type accessToken struct {
	clientID string
	scope    string
	expiry   time.Time
}

const (
	oauthScope      = "boardripper"
	codeTTL         = 5 * time.Minute
	accessTokenTTL  = 24 * time.Hour
	oauthBasePath   = "/api/mcp/oauth"
	authorizePath   = oauthBasePath + "/authorize"
	tokenPath       = oauthBasePath + "/token"
	registerPath    = oauthBasePath + "/register"
	jwksPath        = oauthBasePath + "/jwks"
	prmWellKnown    = "/.well-known/oauth-protected-resource"
	asmWellKnown    = "/.well-known/oauth-authorization-server"
	mcpResourcePath = "/api/mcp"

	// In-memory reclamation bounds (L6): dynamic client registration is
	// unauthenticated on a trusted LAN, so cap the client table and let a
	// periodic sweeper drop expired codes/tokens and idle clients.
	maxClients  = 128             // hard ceiling; oldest (LRU) evicted on overflow
	clientTTL   = 24 * time.Hour  // drop clients unused this long
	sweepPeriod = 10 * time.Minute
)

func NewOAuth() *OAuth {
	o := &OAuth{
		scope:   oauthScope,
		clients: map[string]*oauthClient{},
		codes:   map[string]*authCode{},
		tokens:  map[string]*accessToken{},
	}
	// Single lifetime sweeper: reclaim expired codes/tokens and idle clients so
	// the in-memory tables can't grow unbounded (L6). One goroutine per process.
	go o.sweepLoop()
	return o
}

// GateOAuth serves next only when MCP is enabled AND the auth mode is "oauth";
// otherwise 404 — so every OAuth endpoint (discovery + registration + the AS)
// is invisible when the feature is off or the deployment uses static-token auth,
// matching the invisibility of the main /api/mcp handler.
func GateOAuth(st *State, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if st == nil || !st.Enabled() || st.AuthMode() != "oauth" {
			http.NotFound(w, r)
			return
		}
		next(w, r)
	}
}

// sweepLoop periodically reclaims stale in-memory OAuth state for the process
// lifetime.
func (o *OAuth) sweepLoop() {
	t := time.NewTicker(sweepPeriod)
	defer t.Stop()
	for range t.C {
		o.sweep()
	}
}

// sweep drops expired authorization codes, expired access tokens, and clients
// that have been idle longer than clientTTL.
func (o *OAuth) sweep() {
	now := time.Now()
	o.mu.Lock()
	defer o.mu.Unlock()
	for k, c := range o.codes {
		if now.After(c.expiry) {
			delete(o.codes, k)
		}
	}
	for k, t := range o.tokens {
		if now.After(t.expiry) {
			delete(o.tokens, k)
		}
	}
	for k, c := range o.clients {
		if now.Sub(clientLastRef(c)) > clientTTL {
			delete(o.clients, k)
		}
	}
}

// clientLastRef is the client's most recent activity timestamp (falling back to
// creation time), used for both LRU eviction and the idle sweep.
func clientLastRef(c *oauthClient) time.Time {
	if !c.lastUsed.IsZero() {
		return c.lastUsed
	}
	return c.createdAt
}

// evictOldestClientLocked drops the least-recently-referenced client. Caller
// must hold o.mu.
func (o *OAuth) evictOldestClientLocked() {
	var oldestKey string
	var oldest time.Time
	for k, c := range o.clients {
		ref := clientLastRef(c)
		if oldestKey == "" || ref.Before(oldest) {
			oldestKey, oldest = k, ref
		}
	}
	if oldestKey != "" {
		delete(o.clients, oldestKey)
	}
}

func randToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// base computes the externally-visible base URL from the request, so metadata
// and issued URLs match whatever host the client reached us on.
func base(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	return scheme + "://" + r.Host
}

func oauthJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// ResourceMetadataURL is the absolute PRM URL for the WWW-Authenticate hint.
func (o *OAuth) ResourceMetadataURL(r *http.Request) string { return base(r) + prmWellKnown }

// --- discovery ---

func (o *OAuth) ProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	b := base(r)
	oauthJSON(w, 200, &oauthex.ProtectedResourceMetadata{
		Resource:               b + mcpResourcePath,
		AuthorizationServers:   []string{b},
		ScopesSupported:        []string{o.scope},
		BearerMethodsSupported: []string{"header"},
		ResourceName:           "BoardRipper MCP",
	})
}

func (o *OAuth) AuthServerMetadata(w http.ResponseWriter, r *http.Request) {
	b := base(r)
	oauthJSON(w, 200, &oauthex.AuthServerMeta{
		Issuer:                            b,
		AuthorizationEndpoint:             b + authorizePath,
		TokenEndpoint:                     b + tokenPath,
		JWKSURI:                           b + jwksPath,
		RegistrationEndpoint:              b + registerPath,
		ScopesSupported:                   []string{o.scope},
		ResponseTypesSupported:            []string{"code"},
		GrantTypesSupported:               []string{"authorization_code"},
		TokenEndpointAuthMethodsSupported: []string{"none"},
		CodeChallengeMethodsSupported:     []string{"S256"},
	})
}

// JWKS is intentionally empty — tokens are opaque, not JWTs, so clients never
// need keys (only this resource server verifies, by lookup).
func (o *OAuth) JWKS(w http.ResponseWriter, r *http.Request) {
	oauthJSON(w, 200, map[string]any{"keys": []any{}})
}

// --- dynamic client registration (RFC 7591) ---

func (o *OAuth) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		oauthJSON(w, 400, map[string]string{"error": "invalid_client_metadata"})
		return
	}
	if len(req.RedirectURIs) == 0 {
		oauthJSON(w, 400, map[string]string{"error": "invalid_redirect_uri"})
		return
	}
	id := randToken(16)
	now := time.Now()
	o.mu.Lock()
	if len(o.clients) >= maxClients {
		o.evictOldestClientLocked()
	}
	o.clients[id] = &oauthClient{ID: id, Name: req.ClientName, RedirectURIs: req.RedirectURIs, createdAt: now, lastUsed: now}
	o.mu.Unlock()
	oauthJSON(w, 201, map[string]any{
		"client_id":                  id,
		"redirect_uris":              req.RedirectURIs,
		"client_name":                req.ClientName,
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code"},
		"response_types":             []string{"code"},
	})
}

// --- authorization endpoint (consent + code issuance) ---

func (o *OAuth) Authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if r.Method == http.MethodPost {
		_ = r.ParseForm()
		q = r.Form
	}
	clientID := q.Get("client_id")
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")
	challenge := q.Get("code_challenge")
	method := q.Get("code_challenge_method")
	scope := q.Get("scope")
	if scope == "" {
		scope = o.scope
	}

	o.mu.Lock()
	client := o.clients[clientID]
	if client != nil {
		client.lastUsed = time.Now() // mark active so the sweeper keeps it
	}
	o.mu.Unlock()
	if client == nil || !slices.Contains(client.RedirectURIs, redirectURI) {
		http.Error(w, "invalid client_id or redirect_uri", http.StatusBadRequest)
		return
	}
	if q.Get("response_type") != "code" {
		o.redirectErr(w, r, redirectURI, state, "unsupported_response_type")
		return
	}
	if challenge == "" || method != "S256" {
		o.redirectErr(w, r, redirectURI, state, "invalid_request") // PKCE S256 required
		return
	}

	// POST = the consent decision.
	if r.Method == http.MethodPost {
		if q.Get("decision") != "approve" {
			o.redirectErr(w, r, redirectURI, state, "access_denied")
			return
		}
		code := randToken(24)
		o.mu.Lock()
		o.codes[code] = &authCode{clientID: clientID, redirectURI: redirectURI, challenge: challenge, scope: scope, expiry: time.Now().Add(codeTTL)}
		o.mu.Unlock()
		sep := "?"
		if strings.Contains(redirectURI, "?") {
			sep = "&"
		}
		dest := redirectURI + sep + "code=" + code
		if state != "" {
			dest += "&state=" + html.EscapeString(state)
		}
		http.Redirect(w, r, dest, http.StatusFound)
		return
	}

	// GET = render the consent page.
	o.renderConsent(w, clientID, redirectURI, state, challenge, method, scope, client.Name)
}

func (o *OAuth) redirectErr(w http.ResponseWriter, r *http.Request, redirectURI, state, code string) {
	sep := "?"
	if strings.Contains(redirectURI, "?") {
		sep = "&"
	}
	dest := redirectURI + sep + "error=" + code
	if state != "" {
		dest += "&state=" + html.EscapeString(state)
	}
	http.Redirect(w, r, dest, http.StatusFound)
}

func (o *OAuth) renderConsent(w http.ResponseWriter, clientID, redirectURI, state, challenge, method, scope, name string) {
	if name == "" {
		name = "An AI agent"
	}
	hidden := func(k, v string) string {
		return `<input type="hidden" name="` + k + `" value="` + html.EscapeString(v) + `">`
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8"><title>Authorize — BoardRipper</title>
<style>body{font-family:system-ui,sans-serif;background:#0e1116;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px 32px;max-width:420px}
h1{font-size:18px;margin:0 0 6px}p{color:#9da7b3;line-height:1.5;font-size:14px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:1px solid #30363d;font-size:14px;cursor:pointer}
.approve{background:#2ea043;color:#fff;border-color:#2ea043}.deny{background:transparent;color:#e6edf3}</style></head>
<body><form class="card" method="post" action="` + authorizePath + `">
<h1>Authorize access to BoardRipper</h1>
<p><strong>` + html.EscapeString(name) + `</strong> is requesting access to query your boards, PDFs and reference data over MCP (scope: <code>` + html.EscapeString(scope) + `</code>).</p>` +
		hidden("client_id", clientID) + hidden("redirect_uri", redirectURI) + hidden("state", state) +
		hidden("code_challenge", challenge) + hidden("code_challenge_method", method) +
		hidden("scope", scope) + hidden("response_type", "code") +
		`<div class="row"><button class="deny" name="decision" value="deny">Deny</button>
<button class="approve" name="decision" value="approve">Approve</button></div></form></body></html>`))
}

// --- token endpoint ---

func (o *OAuth) Token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	if r.PostForm.Get("grant_type") != "authorization_code" {
		oauthJSON(w, 400, map[string]string{"error": "unsupported_grant_type"})
		return
	}
	code := r.PostForm.Get("code")
	verifier := r.PostForm.Get("code_verifier")
	redirectURI := r.PostForm.Get("redirect_uri")
	clientID := r.PostForm.Get("client_id")

	o.mu.Lock()
	ac := o.codes[code]
	delete(o.codes, code) // single-use
	o.mu.Unlock()

	if ac == nil || time.Now().After(ac.expiry) {
		oauthJSON(w, 400, map[string]string{"error": "invalid_grant"})
		return
	}
	if ac.clientID != clientID || ac.redirectURI != redirectURI {
		oauthJSON(w, 400, map[string]string{"error": "invalid_grant"})
		return
	}
	// PKCE: base64url(sha256(verifier)) must equal the stored challenge.
	sum := sha256.Sum256([]byte(verifier))
	if subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(ac.challenge)) != 1 {
		oauthJSON(w, 400, map[string]string{"error": "invalid_grant"})
		return
	}

	tok := randToken(32)
	o.mu.Lock()
	o.tokens[tok] = &accessToken{clientID: ac.clientID, scope: oauthScope, expiry: time.Now().Add(accessTokenTTL)}
	o.mu.Unlock()
	log.Printf("mcp oauth: issued token (client=%s, token_len=%d, ttl=%s)", ac.clientID, len(tok), accessTokenTTL)

	oauthJSON(w, 200, map[string]any{
		"access_token": tok,
		"token_type":   "Bearer",
		"expires_in":   int(accessTokenTTL.Seconds()),
		"scope":        ac.scope,
	})
}

// Verifier returns an auth.TokenVerifier that validates opaque tokens by lookup.
func (o *OAuth) Verifier() auth.TokenVerifier {
	return func(_ context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
		o.mu.Lock()
		at := o.tokens[token]
		if at != nil && time.Now().After(at.expiry) {
			delete(o.tokens, token)
			at = nil
		}
		o.mu.Unlock()
		if at == nil {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{Scopes: strings.Fields(at.scope), Expiration: at.expiry, UserID: at.clientID}, nil
	}
}

/**
 * How each AI client connects to BoardRipper's MCP server: one recipe per
 * client, rendered from the server URL and a credential. Pure — the
 * Integrations sheet (panels/settings/IntegrationsSection.tsx) is the only
 * consumer. Adding a client means adding a row here.
 *
 * Formats were checked against each client's docs on 2026-11-11; the ones
 * marked `verify` are from memory and also show the plain snippet, so a wrong
 * deep link still leaves the user something that works.
 */

export type ClientGroup = 'editor' | 'desktop' | 'cloud';
export type ClientMethod = 'command' | 'deeplink' | 'snippet' | 'remote';

export interface ClientRecipe {
  id: string;
  label: string;
  /** Short line under the label on the tile. */
  sub: string;
  group: ClientGroup;
  method: ClientMethod;
  /** One sentence: what the user does with the action below. */
  how: string;
  /** Tool groups this client asks for by default (none = every tool). Editor
   *  agents get fewer, because some cap the tools they pass on. */
  tools?: string[];
  /** Supports MCP OAuth discovery, so it can connect with the URL alone. */
  oauth?: boolean;
  /** Deep-link format not confirmed against current docs. */
  verify?: boolean;
}

const EDITOR_TOOLS = ['board', 'drive', 'pdf', 'worklist'];

export const CLIENT_RECIPES: ClientRecipe[] = [
  { id: 'claude-code', label: 'Claude Code', sub: 'terminal', group: 'editor', method: 'command', oauth: true,
    how: 'Run this in your terminal, then type /mcp in Claude Code to check the connection.' },
  { id: 'cursor', label: 'Cursor', sub: 'one click', group: 'editor', method: 'deeplink', tools: EDITOR_TOOLS, oauth: true, verify: true,
    how: 'Opens Cursor and asks you to confirm. If nothing opens, paste the snippet into ~/.cursor/mcp.json.' },
  { id: 'vscode', label: 'VS Code', sub: 'Copilot · one click', group: 'editor', method: 'deeplink', tools: EDITOR_TOOLS, oauth: true,
    how: 'Opens VS Code’s install page for this server. Click Install there.' },
  { id: 'windsurf', label: 'Windsurf', sub: 'config file', group: 'editor', method: 'snippet', tools: EDITOR_TOOLS, verify: true,
    how: 'Paste into ~/.codeium/windsurf/mcp_config.json and reload Windsurf.' },
  { id: 'codex', label: 'Codex', sub: 'CLI and IDE', group: 'editor', method: 'command',
    how: 'Codex reads the token from an environment variable. Run both lines; put the export in your shell profile to keep it.' },
  { id: 'gemini', label: 'Gemini CLI', sub: 'terminal', group: 'editor', method: 'command',
    how: 'Run this in your terminal.' },
  { id: 'zed', label: 'Zed', sub: 'config file', group: 'editor', method: 'snippet', tools: EDITOR_TOOLS, verify: true,
    how: 'Add this to Zed’s settings.json.' },
  { id: 'claude-desktop', label: 'Claude Desktop', sub: 'config file', group: 'desktop', method: 'snippet',
    how: 'Paste into claude_desktop_config.json (Settings ▸ Developer ▸ Edit Config) and restart Claude Desktop. Needs Node.js.' },
  { id: 'lmstudio', label: 'LM Studio', sub: 'one click · local models', group: 'desktop', method: 'deeplink', tools: EDITOR_TOOLS, verify: true,
    how: 'Opens LM Studio and adds the server. If nothing opens, paste the snippet into LM Studio’s mcp.json.' },
  { id: 'all', label: 'All on this computer', sub: 'needs Node.js', group: 'desktop', method: 'command',
    how: 'add-mcp finds the assistants installed on this computer (Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Goose, Copilot CLI, OpenCode, VS Code, Zed) and adds BoardRipper to each.' },
  { id: 'other', label: 'Other', sub: 'URL + header', group: 'editor', method: 'snippet',
    how: 'Any client that speaks MCP over Streamable HTTP.' },
  { id: 'chatgpt', label: 'ChatGPT', sub: 'remote access', group: 'cloud', method: 'remote',
    how: 'ChatGPT connects from OpenAI’s servers on the internet, so it cannot reach BoardRipper on your network. This needs a public HTTPS address, which BoardRipper does not set up yet.' },
  { id: 'claude-ai', label: 'claude.ai', sub: 'web and mobile', group: 'cloud', method: 'remote',
    how: 'claude.ai connects from Anthropic’s servers on the internet, so it cannot reach BoardRipper on your network. Use Claude Desktop or Claude Code on this network instead.' },
];

export interface RecipeContext {
  /** Base MCP URL, e.g. http://rd-nas:1336/api/mcp */
  baseUrl: string;
  /** Bearer token; '' when OAuth will be used instead. */
  token: string;
  /** Server is in OAuth mode. */
  oauthMode: boolean;
}

export interface RenderedRecipe {
  url: string;
  /** Text to copy (command or config). Absent for remote. */
  snippet?: string;
  /** Deep link to open. */
  link?: string;
  /** Primary button label. */
  action: string;
  /** True when the snippet contains no secret (OAuth). */
  usesOAuth: boolean;
}

/** OAuth only where the client supports it AND the address allows it: OAuth
 *  2.1 clients may refuse a plain-http authorization server unless it is
 *  loopback. */
export function canUseOAuth(recipe: ClientRecipe, ctx: RecipeContext): boolean {
  if (!ctx.oauthMode || !recipe.oauth) return false;
  try {
    const u = new URL(ctx.baseUrl);
    return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

export function serverUrl(base: string, tools?: string[]): string {
  return tools && tools.length ? `${base}?tools=${tools.join(',')}` : base;
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export function renderRecipe(recipe: ClientRecipe, ctx: RecipeContext): RenderedRecipe {
  const usesOAuth = canUseOAuth(recipe, ctx);
  const url = serverUrl(ctx.baseUrl, recipe.tools);
  const t = ctx.token || '<token>';
  const header = `Authorization: Bearer ${t}`;
  const headers = usesOAuth ? undefined : { Authorization: `Bearer ${t}` };
  const json = (v: unknown) => JSON.stringify(v, null, 2);

  switch (recipe.id) {
    case 'claude-code':
      return { url, usesOAuth, action: 'Copy command',
        snippet: usesOAuth
          ? `claude mcp add --transport http boardripper ${url}`
          : `claude mcp add --transport http boardripper ${url} \\\n  --header "${header}"` };
    case 'cursor': {
      const cfg = { url, ...(headers ? { headers } : {}) };
      return { url, usesOAuth, action: 'Add to Cursor',
        link: `cursor://anysphere.cursor-deeplink/mcp/install?name=boardripper&config=${encodeURIComponent(b64(JSON.stringify(cfg)))}`,
        snippet: json({ mcpServers: { boardripper: cfg } }) };
    }
    case 'vscode': {
      const cfg = { name: 'boardripper', type: 'http', url, ...(headers ? { headers } : {}) };
      return { url, usesOAuth, action: 'Add to VS Code',
        link: `vscode:mcp/install?${encodeURIComponent(JSON.stringify(cfg))}`,
        snippet: json({ servers: { boardripper: { type: 'http', url, ...(headers ? { headers } : {}) } } }) };
    }
    case 'windsurf':
      return { url, usesOAuth, action: 'Copy',
        snippet: json({ mcpServers: { boardripper: { serverUrl: url, headers: { Authorization: `Bearer ${t}` } } } }) };
    case 'codex':
      return { url, usesOAuth, action: 'Copy commands',
        snippet: `export BOARDRIPPER_TOKEN=${t}\ncodex mcp add boardripper --url ${url} \\\n  --bearer-token-env-var BOARDRIPPER_TOKEN` };
    case 'gemini':
      return { url, usesOAuth, action: 'Copy command',
        snippet: `gemini mcp add --transport http \\\n  --header "${header}" \\\n  boardripper ${url}` };
    case 'zed':
      return { url, usesOAuth, action: 'Copy',
        snippet: json({ context_servers: { boardripper: { url, headers: { Authorization: `Bearer ${t}` } } } }) };
    case 'claude-desktop':
      return { url, usesOAuth, action: 'Copy',
        snippet: json({ mcpServers: { boardripper: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', header] } } }) };
    case 'lmstudio': {
      const cfg = { url, headers: { Authorization: `Bearer ${t}` } };
      return { url, usesOAuth, action: 'Add to LM Studio',
        link: `lmstudio://add_mcp?name=boardripper&config=${encodeURIComponent(b64(JSON.stringify(cfg)))}`,
        snippet: json({ mcpServers: { boardripper: cfg } }) };
    }
    case 'all':
      return { url, usesOAuth, action: 'Copy command',
        snippet: `npx add-mcp ${url} --name boardripper \\\n  --header "${header}" --all -g` };
    case 'chatgpt':
    case 'claude-ai':
      return { url, usesOAuth, action: '' };
    default:
      return { url, usesOAuth, action: 'Copy',
        snippet: usesOAuth
          ? `URL:  ${url}\nAuth: OAuth (approve in the browser on first connect)`
          : `URL:    ${url}\nHeader: ${header}` };
  }
}

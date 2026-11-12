import { describe, it, expect } from 'vitest';
import { CLIENT_RECIPES, renderRecipe, canUseOAuth, type RecipeContext } from './mcp-clients';

const lan: RecipeContext = { baseUrl: 'http://rd-nas:1336/api/mcp', token: 'tok123', oauthMode: false };
const recipe = (id: string) => CLIENT_RECIPES.find(r => r.id === id)!;

describe('mcp client recipes', () => {
  it('every installable recipe yields a snippet or a link carrying the token', () => {
    for (const r of CLIENT_RECIPES) {
      const out = renderRecipe(r, lan);
      if (r.method === 'remote') { expect(out.snippet).toBeUndefined(); continue; }
      expect(out.snippet ?? out.link).toBeTruthy();
      expect(out.action).not.toBe('');
      const text = (out.snippet ?? '') + decodeURIComponent(out.link ?? '');
      const linkCfg = out.link?.includes('config=')
        ? atob(decodeURIComponent(out.link.split('config=')[1])) : '';
      expect(text + linkCfg).toContain('tok123');
    }
  });

  it('editor clients ask for the smaller tool set', () => {
    expect(renderRecipe(recipe('cursor'), lan).url).toBe('http://rd-nas:1336/api/mcp?tools=board,drive,pdf,worklist');
    expect(renderRecipe(recipe('claude-code'), lan).url).toBe('http://rd-nas:1336/api/mcp');
  });

  it('the VS Code link is the documented vscode:mcp/install form', () => {
    const link = renderRecipe(recipe('vscode'), lan).link!;
    expect(link.startsWith('vscode:mcp/install?')).toBe(true);
    const cfg = JSON.parse(decodeURIComponent(link.slice('vscode:mcp/install?'.length)));
    expect(cfg).toMatchObject({ name: 'boardripper', type: 'http', headers: { Authorization: 'Bearer tok123' } });
  });

  it('OAuth only on HTTPS or loopback, and only for clients that support it', () => {
    expect(canUseOAuth(recipe('claude-code'), { ...lan, oauthMode: true })).toBe(false);
    const https = { baseUrl: 'https://br.example.org/api/mcp', token: '', oauthMode: true };
    expect(canUseOAuth(recipe('claude-code'), https)).toBe(true);
    expect(canUseOAuth(recipe('codex'), https)).toBe(false);
    const cc = renderRecipe(recipe('claude-code'), https);
    expect(cc.usesOAuth).toBe(true);
    expect(cc.snippet).not.toContain('Authorization');
  });

  it('add-mcp installs globally, not into the current folder', () => {
    expect(renderRecipe(recipe('all'), lan).snippet).toMatch(/--all -g$/);
  });
});

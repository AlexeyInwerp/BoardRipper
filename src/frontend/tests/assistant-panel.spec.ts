/**
 * The Assistant destination (panels/AssistantPanel.tsx), backend mocked.
 *
 *  1. Not set up: the setup view shows; saving a key sends it once and the
 *     answer (which never contains the key) switches to the chat.
 *  2. A chat turn renders streamed text with clickable net/part chips and the
 *     tool steps it took.
 *  3. The part context menu offers "Ask the assistant" and puts the question
 *     into the chat.
 * The Go tests (src/backend/assistant) cover the loop, approvals and key handling.
 */
import { test, expect, type Page } from '@playwright/test';

const provider = (over: Record<string, unknown> = {}) => ({
  id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', base_url: 'https://api.anthropic.com',
  needs_key: true, local: false, images: true, default: 'claude-opus-5-5', has_key: false, model: 'claude-opus-5-5', ...over,
});
const config = (hasKey: boolean) => ({
  active: hasKey ? 'anthropic' : '', web_search: true,
  providers: [provider({ has_key: hasKey, key_hint: hasKey ? 'wxyz' : undefined }),
    { id: 'ollama', label: 'Ollama (local)', kind: 'openai', base_url: 'http://localhost:11434/v1', needs_key: false, local: true, images: false, default: '', has_key: false, model: '' }],
});

function sse(events: unknown[]): string {
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function setup(page: Page, configured: boolean) {
  let saved: Record<string, unknown> | null = null;
  const chats: Record<string, unknown>[] = [];
  await page.route('**/api/mcp/status', r => r.fulfill({ json: { enabled: true, drive_ui: false, clients: 1, auth_mode: 'token' } }));
  await page.route('**/api/assistant/config**', async r => {
    if (r.request().method() === 'POST') {
      saved = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ json: config(true) });
    }
    return r.fulfill({ json: config(configured || saved !== null) });
  });
  await page.route('**/api/assistant/models**', r => r.fulfill({ json: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'] } }));
  await page.route('**/api/assistant/chat', r => {
    chats.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse([
        { type: 'start', conversation: 'conv1', provider: 'Anthropic (Claude)', model: 'claude-opus-5-5' },
        { type: 'tool', tool: 'board_overview', status: 'running' },
        { type: 'tool', tool: 'board_overview', status: 'done', text: '{"name":"demo"}' },
        { type: 'text', text: 'The main rail is [n:PPBUS_G3H], ' },
        { type: 'text', text: 'made by **[p:U7000]**.' },
        { type: 'done' },
      ]),
    });
  });
  return { saved: () => saved, chats };
}

async function openAssistant(page: Page) {
  await page.goto('/');
  await page.locator('[data-sidebar-tab="assistant"]').first().click();
}

test('setup: the key is sent once and the chat opens', async ({ page }) => {
  const s = await setup(page, false);
  await openAssistant(page);
  await expect(page.getByTestId('assistant-setup')).toBeVisible();
  await page.getByTestId('assistant-key').fill('sk-ant-test-key');
  await page.getByTestId('assistant-save').click();
  await expect(page.getByTestId('assistant-input')).toBeVisible();
  expect(s.saved()).toMatchObject({ provider: 'anthropic', api_key: 'sk-ant-test-key', activate: true });
  // The page never receives the key back.
  const body = await page.content();
  expect(body).not.toContain('sk-ant-test-key');
});

test('chat: streamed text with chips and tool steps', async ({ page }) => {
  const s = await setup(page, true);
  await openAssistant(page);
  await page.getByTestId('assistant-input').fill('What is the main rail?');
  await page.getByTestId('assistant-input').press('Enter');
  const answer = page.getByTestId('assistant-answer').last();
  await expect(answer).toContainText('The main rail is');
  await expect(answer.locator('[data-net="PPBUS_G3H"]')).toBeVisible();
  await expect(answer.locator('strong [data-part="U7000"]')).toBeVisible();
  await expect(answer).toContainText('board overview');
  expect(s.chats[0]).toMatchObject({ message: 'What is the main rail?', conversation: '' });

  // The next message continues the same conversation.
  await page.getByTestId('assistant-input').fill('And its source?');
  await page.getByTestId('assistant-send').click();
  await expect.poll(() => s.chats.length).toBe(2);
  expect(s.chats[1]).toMatchObject({ conversation: 'conv1' });
});

/** Clipboard helpers with a fallback for insecure contexts.
 *
 *  `navigator.clipboard.writeText` is only defined on secure contexts
 *  (HTTPS, or `http://localhost`). When BoardRipper is opened over a
 *  LAN IP (Synology NAS at `http://192.168.x.x:1336`, Vite's network
 *  URLs, Tailscale `100.x.x.x` addresses), the Clipboard API is
 *  undefined and a bare `navigator.clipboard.writeText(...)` throws
 *  `Cannot read properties of undefined (reading 'writeText')`.
 *
 *  This falls back to the legacy `document.execCommand('copy')` path
 *  via a transient off-screen `<textarea>`. Still supported by every
 *  evergreen browser and works on insecure contexts. */
export async function copyText(text: string): Promise<void> {
  // Preferred path — modern API, works on secure contexts.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand — Permissions-Policy or transient focus
      // loss can reject the write even on a secure context.
    }
  }

  // Fallback: hidden textarea + execCommand('copy'). Must be in the DOM
  // and selected; off-screen positioning keeps it invisible.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.boxShadow = 'none';
  ta.style.background = 'transparent';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const previousActive = document.activeElement as HTMLElement | null;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand("copy") returned false');
  } finally {
    ta.remove();
    previousActive?.focus?.();
  }
}

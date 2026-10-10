// src/frontend/src/dom-translate-guard.ts
//
// Keeps the browser's page translator from crashing React (issue #36).
//
// Chrome and Edge "Translate page" replace each text node they translate with
// <font><font>translated</font></font>. React still holds the original node,
// so its next removeChild(oldNode) or insertBefore(x, oldNode) throws
// NotFoundError. Inside a panel that is "This panel crashed"; in the status
// bar, toasts or the load overlay, which sit outside every boundary, it
// unmounted the whole app. Chinese part values and XZZ repair notes are
// exactly what makes people turn translation on.
//
// The guard makes both calls tolerate a node that is no longer a child:
// removing it is a no-op, inserting before it appends. Text can then be stale
// or out of order until the next re-render, but nothing throws. Sites people
// see often are fixed properly instead (each text run in its own element, so
// React removes the element, translation and all); this covers the rest and
// whatever gets written next. It is the widely used workaround for
// facebook/react#11538.
//
// Only a mismatch is intercepted: a correct call goes straight through, so
// PixiJS, pdf.js and Dockview see the native behaviour. The first time it
// fires it logs once, so a real DOM bug cannot hide behind it unnoticed.

import { log } from './store/log-store';

let installed = false;
let warned = false;

function warnOnce(op: string, node: Node) {
  if (warned) return;
  warned = true;
  log.ui.warn(
    `DOM ${op} on a node that is no longer a child — tolerated (usually the browser's page translator rewrote the text). ` +
    `node=${node.nodeName}`,
  );
}

export function installTranslateGuard(): void {
  if (installed || typeof Node !== 'function' || !Node.prototype) return;
  installed = true;
  const origRemove = Node.prototype.removeChild;
  const origInsert = Node.prototype.insertBefore;

  Node.prototype.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      warnOnce('removeChild', child);
      return child;
    }
    return origRemove.call(this, child) as T;
  };

  Node.prototype.insertBefore = function insertBefore<T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) {
      warnOnce('insertBefore', ref);
      return origInsert.call(this, node, null) as T;
    }
    return origInsert.call(this, node, ref) as T;
  };
}

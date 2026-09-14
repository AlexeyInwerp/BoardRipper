/**
 * Settings ▸ Library ▸ Scanning & Indexing ▸ Automatic linking.
 *
 * The master switch (`auto_bind`) and the rule ladder (`auto_bind_rules`),
 * with Preview (dry run, per-rule counts and samples) and Link now. Rules
 * are fixed in order — the user tunes and toggles, never reorders — and the
 * two loose ones are folder-bounded because similarity cannot be indexed.
 * Every automatic link remembers its rule, so links can be removed per rule.
 */

import { useCallback, useEffect, useState } from 'react';
import { useDatabank } from '../../hooks/useDatabank';
import {
  databankStore, DEFAULT_AUTOBIND_RULES, AUTOBIND_RULE_LABEL, AUTOBIND_RADIUS_LABEL,
  type AutoBindRules, type AutoBindReport,
} from '../../store/databank-store';
import { boardStore } from '../../store/board-store';

const RULE_ORDER = ['exact', 'number', 'fuzzy', 'lone'] as const;

function RadiusSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <select value={value} onChange={e => onChange(Number(e.target.value))} className="autobind-radius">
      {[0, 1, 2].map(r => <option key={r} value={r}>{AUTOBIND_RADIUS_LABEL[r]}</option>)}
    </select>
  );
}

export function AutoBindSection() {
  const { backendAvailable, electronMode } = useDatabank();
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<AutoBindRules>(DEFAULT_AUTOBIND_RULES);
  const [loaded, setLoaded] = useState(false);
  const [report, setReport] = useState<AutoBindReport | null>(null);
  const [existing, setExisting] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<'' | 'preview' | 'run' | 'delete'>('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (electronMode || !backendAvailable) return;
    fetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then((cfg: Record<string, string> | null) => {
        if (cfg) {
          setEnabled(cfg.auto_bind === 'true');
          if (cfg.auto_bind_rules) {
            try { setRules({ ...DEFAULT_AUTOBIND_RULES, ...JSON.parse(cfg.auto_bind_rules) }); } catch { /* keep defaults */ }
          }
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    // The DB's current per-rule counts, for the remove-by-rule row.
    void databankStore.previewAutoBind().then(r => { if (r) setExisting(r.existing ?? {}); });
  }, [backendAvailable, electronMode]);

  const persistRules = useCallback((next: AutoBindRules) => {
    setRules(next);
    setReport(null);
    void databankStore.setConfig('auto_bind_rules', JSON.stringify(next));
  }, []);

  const toggleMaster = async (on: boolean) => {
    setEnabled(on);
    await databankStore.setConfig('auto_bind', on ? 'true' : '');
  };

  const preview = async () => {
    setBusy('preview'); setNote('');
    try {
      const r = await databankStore.previewAutoBind(rules);
      if (r) { setReport(r); setExisting(r.existing ?? {}); }
      else setNote('Preview failed — see the Debug panel.');
    } finally { setBusy(''); }
  };

  const run = async () => {
    setBusy('run'); setNote('');
    try {
      const r = await databankStore.runAutoBind(rules);
      if (r) {
        setReport(r); setExisting(r.existing ?? {});
        setNote(`Linked ${r.inserted} of ${r.boards} unbound boards.`);
        boardStore.addToast(`Linked ${r.inserted} board${r.inserted === 1 ? '' : 's'} to PDFs`, 'info');
      } else setNote('Linking failed — see the Debug panel.');
    } finally { setBusy(''); }
  };

  const remove = async (rule: string) => {
    const label = rule === '*' ? 'every automatic link' : `the links made by "${AUTOBIND_RULE_LABEL[rule] ?? rule}"`;
    if (!confirm(`Remove ${label}? Links you made by hand are kept.`)) return;
    setBusy('delete');
    try {
      const r = await databankStore.deleteAutoBindings(rule);
      if (r) { setExisting(r.existing ?? {}); setNote(`Removed ${r.deleted} link${r.deleted === 1 ? '' : 's'}.`); setReport(null); }
    } finally { setBusy(''); }
  };

  if (electronMode || !loaded) return null;

  const existingTotal = Object.values(existing).reduce((a, b) => a + b, 0);

  return (
    <div className="settings-subsection autobind" data-testid="autobind-section">
      <div className="settings-subsection-label">Automatic linking</div>

      <div className="settings-row settings-toggle-row">
        <label className="settings-label" title="Runs the rules below at the end of every scan, for boards that have no link yet">
          Link boards to PDFs during scans
        </label>
        <input type="checkbox" checked={enabled} onChange={e => toggleMaster(e.target.checked)} data-testid="autobind-enabled" />
      </div>

      <div className="autobind-rules">
        <label className="autobind-rule">
          <input type="checkbox" checked={rules.exact} onChange={e => persistRules({ ...rules, exact: e.target.checked })} />
          <span className="autobind-rule-name">1. Same name</span>
          <span className="autobind-rule-hint">board.brd ↔ board.pdf, anywhere in the library</span>
        </label>
        <label className="autobind-rule">
          <input type="checkbox" checked={rules.number} onChange={e => persistRules({ ...rules, number: e.target.checked })} />
          <span className="autobind-rule-name">2. Board number in the PDF name</span>
          <span className="autobind-rule-hint">820-01234.brd ↔ "820-01234 schematic.pdf", anywhere</span>
        </label>
        <label className="autobind-rule">
          <input type="checkbox" checked={rules.fuzzy.on} onChange={e => persistRules({ ...rules, fuzzy: { ...rules.fuzzy, on: e.target.checked } })} />
          <span className="autobind-rule-name">3. Similar name</span>
          <span className="autobind-rule-hint">
            at least{' '}
            <input type="number" min={1} max={100} value={rules.fuzzy.min} className="autobind-pct"
              onChange={e => persistRules({ ...rules, fuzzy: { ...rules.fuzzy, min: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } })} />
            % of the shorter name's words, within{' '}
            <RadiusSelect value={rules.fuzzy.radius} onChange={r => persistRules({ ...rules, fuzzy: { ...rules.fuzzy, radius: r } })} />
          </span>
        </label>
        <label className="autobind-rule">
          <input type="checkbox" checked={rules.lone.on} onChange={e => persistRules({ ...rules, lone: { ...rules.lone, on: e.target.checked } })} />
          <span className="autobind-rule-name">4. Only PDF in the folder</span>
          <span className="autobind-rule-hint">
            within <RadiusSelect value={rules.lone.radius} onChange={r => persistRules({ ...rules, lone: { ...rules.lone, radius: r } })} />
            {' '}
            <label className="autobind-sub">
              <input type="checkbox" checked={rules.lone.require_one_board}
                onChange={e => persistRules({ ...rules, lone: { ...rules.lone, require_one_board: e.target.checked } })} />
              only if the folder has one board too
            </label>
          </span>
        </label>
        <p className="settings-hint">
          Links are made by the first rule that matches. Rules 3 and 4 can link the wrong PDF — preview first.
          Turning a rule on only adds links; turning it off removes nothing. Every link remembers its rule.
        </p>
      </div>

      <div className="settings-row-field">
        <span>Boards without a link</span>
        <span className="settings-pdfindex-actions">
          <button className="settings-action-btn" onClick={preview} disabled={busy !== ''} data-testid="autobind-preview">
            {busy === 'preview' ? 'Previewing…' : 'Preview'}
          </button>
          <button className="settings-action-btn" onClick={run} disabled={busy !== ''} data-testid="autobind-run">
            {busy === 'run' ? 'Linking…' : 'Link now'}
          </button>
        </span>
      </div>

      {report && (
        <div className="autobind-report" data-testid="autobind-report">
          <div>
            Would link <b>{report.total}</b> of {report.boards} unbound boards
            {report.total > 0 && (
              <> — {RULE_ORDER.filter(r => report.counts[r]).map(r => `${AUTOBIND_RULE_LABEL[r]} ${report.counts[r]}`).join(' · ')}</>
            )}
          </div>
          {RULE_ORDER.filter(r => (report.samples[r] ?? []).length > 0).map(r => (
            <details key={r} className="autobind-samples">
              <summary>{AUTOBIND_RULE_LABEL[r]} — {report.counts[r]} link{report.counts[r] === 1 ? '' : 's'}, examples</summary>
              <ul>
                {report.samples[r].map(c => (
                  <li key={`${c.board_id}-${c.pdf_id}`} title={`${c.board_path} ↔ ${c.pdf_path}`}>
                    <span>{c.board_name}</span> ↔ <span>{c.pdf_name}</span>
                    {r === 'fuzzy' && <em> {c.score} %{c.shared?.length ? ` · shares ${c.shared.join(', ')}` : ''}</em>}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}

      {existingTotal > 0 && (
        <div className="autobind-existing" data-testid="autobind-existing">
          <span>Automatic links in the database:</span>
          {Object.entries(existing).filter(([, n]) => n > 0).map(([r, n]) => (
            <span key={r} className="autobind-existing-item">
              {AUTOBIND_RULE_LABEL[r] ?? r} <b>{n}</b>
              <button type="button" onClick={() => remove(r)} disabled={busy !== ''} title={`Remove the ${n} link${n === 1 ? '' : 's'} this rule made`}>remove</button>
            </span>
          ))}
          <button type="button" onClick={() => remove('*')} disabled={busy !== ''}>remove all</button>
        </div>
      )}
      {note && <p className="settings-hint">{note}</p>}
    </div>
  );
}

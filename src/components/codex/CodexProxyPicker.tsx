import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Gauge, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { catalogErrorKey, catalogGroupKindKey, catalogGroupNodes, catalogSelectors, catalogUnsupportedKey, isCatalogBlockingMember, type ProxyCatalogGroup, type ProxyCatalogSelections, type ProxyCatalogSource } from '../../services/codexProxyCatalogService';
import { proxySelectionGroup } from '../../utils/codexProxySelection';
import type { useProxyLatency } from './useProxyLatency';
import { proxyPickerPosition } from '../../utils/codexProxyPickerPosition';
import { ModalErrorMessage } from '../ModalErrorMessage';

interface Option { value: string; label: string; detail?: string; badge?: ReactNode; disabled?: boolean; measure?: { label: string; disabled: boolean; run: () => void } }
function SearchSelect({ value, options, label, placeholder, searchPlaceholder, disabled, onChange, footer }: {
  value: string; options: Option[]; label: string; placeholder: string; searchPlaceholder?: string; disabled: boolean; onChange: (id: string) => void; footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false); const [query, setQuery] = useState('');
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null); const id = useId();
  const selected = options.find((option) => option.value === value);
  const visible = options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const panel = menu.current;
      const list = panel?.querySelector<HTMLElement>('.codex-picker-options');
      const contentHeight = panel && list
        ? panel.getBoundingClientRect().height - list.getBoundingClientRect().height + list.scrollHeight
        : 400;
      setPosition({ ...proxyPickerPosition(rect.top, rect.bottom, window.innerHeight, contentHeight),
        left: Math.max(6, Math.min(rect.left, window.innerWidth - Math.min(rect.width, window.innerWidth - 12) - 6)),
        width: Math.min(rect.width, window.innerWidth - 12) });
    };
    reposition();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [open, query, options, footer]);
  useEffect(() => { if (open) menu.current?.querySelector('input')?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div className="codex-picker-select"><span className="codex-picker-label">{label}</span>
    <button ref={trigger} type="button" className="codex-picker-trigger" disabled={disabled} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setQuery(''); setOpen(!open); }}><span>{selected?.label ?? placeholder}</span>{selected?.badge}<ChevronDown size={17} /></button>
    {open && createPortal(<div ref={menu} id={id} role="dialog" aria-label={label} className="codex-picker-menu" style={{ ...position, position: 'fixed' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('.codex-picker-option:not(:disabled)') ?? [])];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
      <div className="codex-picker-menu-header">
        <label className="codex-proxy-search"><Search size={15} /><input value={query} aria-label={searchPlaceholder ?? t('codex.proxy.catalog.search')}
          placeholder={searchPlaceholder ?? t('codex.proxy.catalog.search')} onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="button" className="btn btn-secondary compact" aria-label={t('common.close')} onClick={close}><X size={16} /></button>
      </div>
      <div role="group" aria-label={label} className="codex-picker-options">{visible.map((option) => <div className="codex-picker-option-row" key={option.value}>
        <button type="button" aria-pressed={value === option.value}
          disabled={option.disabled} className={'codex-picker-option' + (value === option.value ? ' active' : '')} onClick={() => { onChange(option.value); close(); }}>
          <span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>{option.badge}{value === option.value && <Check size={15} />}
        </button>
        {option.measure && <button type="button" className="btn btn-secondary compact codex-picker-measure" disabled={option.measure.disabled}
          aria-label={`${option.label} · ${option.measure.label}`} title={option.measure.label} onClick={option.measure.run}><Gauge size={16} /></button>}
      </div>)}
        {!visible.length && <p className="codex-proxy-page-note">{t('codex.proxy.catalog.noResults')}</p>}</div>
      {footer && <div className="codex-picker-menu-footer">{footer}</div>}
    </div>, document.body)}
  </div>;
}

export function CodexProxyPicker({ source, itemId, selectedGroupId, selections, busy, latency, choose, chooseMember, setInsecure }: {
  source: ProxyCatalogSource; itemId: string; selectedGroupId?: string; selections: ProxyCatalogSelections; busy: boolean; latency: ReturnType<typeof useProxyLatency>;
  choose: (id: string, groupId: string) => void; chooseMember: (groupId: string, memberName: string) => void;
  setInsecure?: (nodeId: string, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const groupId = proxySelectionGroup(source, itemId, selectedGroupId);
  const group = source.groups.find((entry) => entry.id === groupId);
  const selectedGroup = source.groups.find((entry) => entry.id === itemId);
  const node = source.nodes.find((entry) => entry.id === itemId);
  const selectedItem = selectedGroup ?? node;
  /** A self-built strategy is still a source; the badge only marks what it is. */
  const strategy = source.kind === 'strategy';
  const policyBadge = (entry: ProxyCatalogGroup) => <span className="codex-picker-badge" title={strategy ? t('codex.proxy.catalog.strategyTag') : undefined}>{t(catalogGroupKindKey(entry.kind))}</span>;
  /** The browsing parent is not necessarily the selected policy. Follow explicit selectors only. */
  const policyGroup = useMemo(() => {
    let current = selectedGroup;
    const visited = new Set<string>();
    while (current?.kind === 'select' && !visited.has(current.id)) {
      visited.add(current.id);
      const next = source.groups.find((entry) => entry.name === selections[current!.id]);
      if (!next || visited.has(next.id)) break;
      current = next;
    }
    return current;
  }, [source, selectedGroup, selections]);
  const hintKey = policyGroup?.kind === 'select' ? 'codex.proxy.catalog.selectGroupHint'
    : policyGroup?.kind === 'url-test' ? 'codex.proxy.catalog.autoGroupHint'
      : policyGroup?.kind === 'fallback' || policyGroup?.kind === 'load-balance' ? 'codex.proxy.catalog.policyGroupHint'
        : 'codex.proxy.catalog.selectionHint';
  const ids = useMemo(() => group ? catalogGroupNodes(source, group.id, true) : source.nodes.map((node) => node.id), [source, group]);
  const testIds = useMemo(() => group ? catalogGroupNodes(source, group.id) : [], [source, group]);
  const manualGroups = useMemo(() => catalogSelectors(source, itemId, selections), [source, itemId, selections]);
  const selectedBlockingMember = manualGroups.some((selector) => selector.members.includes(selections[selector.id]) && isCatalogBlockingMember(selections[selector.id]));
  let selectionErrorKey = itemId && !selectedItem?.supported ? catalogUnsupportedKey(selectedItem) : '';
  for (const selector of manualGroups) {
    const name = selections[selector.id];
    if (selectionErrorKey || !name || isCatalogBlockingMember(name)) continue;
    const member = source.nodes.find((entry) => entry.name === name) ?? source.groups.find((entry) => entry.name === name);
    if (!selector.members.includes(name) || !member?.supported || name === selector.name) selectionErrorKey = catalogUnsupportedKey(member, name);
  }
  const locked = busy || latency.running;
  const dnsSetupErrorKey = Object.values(latency.results)
    .map((result) => result.status === 'error' ? catalogErrorKey(result.error) : '')
    .find((key) => key === 'codex.proxy.catalog.errorDns' || key === 'codex.proxy.catalog.errorEchDns');
  const badge = (id: string) => { const result = latency.results[id]; return result && <span className={'codex-picker-badge ' + result.status}>{result.status === 'success' ? `${result.value.httpError ? 'HTTPS' : 'HTTP'} ${result.value.latencyMs} ms` : result.status === 'error' ? t('common.failed') : t('codex.proxy.catalog.latency_' + result.status)}</span>; };
  const nodeDetail = (entry: ProxyCatalogSource['nodes'][number]) => {
    const result = latency.results[entry.id];
    return result?.status === 'error' ? t(catalogErrorKey(result.error))
      : result?.status === 'success' ? `${entry.protocol.toUpperCase()} · ${result.value.httpError ? `HTTP ${t(catalogErrorKey(result.value.httpError))} · ` : ''}HTTPS ${result.value.httpsMs == null
        ? result.value.httpsError ? t(catalogErrorKey(result.value.httpsError)) : t('common.failed')
        : `${result.value.httpsMs} ms`}`
      : entry.supported ? entry.protocol.toUpperCase() : t(catalogUnsupportedKey(entry));
  };
  const nodes = ids.flatMap((id) => source.nodes.filter((entry) => entry.id === id));
  const groupMeasure = (id: string) => {
    const members = catalogGroupNodes(source, id);
    return { label: t('codex.proxy.catalog.measureGroup', { count: members.length }), disabled: locked || !members.length, run: () => latency.measure(members) };
  };
  const progress = latency.total > 0 && <div className="codex-resource-progress" role="status">
    <span>{t('codex.proxy.catalog.measureProgress', { completed: latency.completed, total: latency.total })}</span>
    {latency.running && <button type="button" className="btn btn-secondary compact" onClick={latency.cancel}>{t('common.cancel')}</button>}
  </div>;
  return <div className="codex-picker">
    <div className="codex-picker-row"><SearchSelect label={t('codex.proxy.catalog.groups')} placeholder={t('codex.proxy.catalog.groups')} value={groupId} disabled={busy}
      searchPlaceholder={strategy ? t('codex.proxy.catalog.strategyFilter') : undefined}
      options={[{ value: '', label: t('codex.proxy.catalog.nodes') }, ...source.groups.map((entry) => ({ value: entry.id, label: entry.name, badge: policyBadge(entry), detail: entry.supported ? undefined : t(catalogUnsupportedKey(entry)) }))]}
      onChange={(id) => { latency.cancel(); choose(id, id); }} />
      <button type="button" className="btn btn-secondary compact codex-picker-icon-button"
        aria-label={t('codex.proxy.catalog.measureGroup', { count: testIds.length })} title={t('codex.proxy.catalog.measureGroup', { count: testIds.length })}
        disabled={locked || !testIds.length} onClick={() => latency.measure(testIds)}><Gauge size={17} /></button>
    </div>
    {manualGroups.map((selector) => <div className="codex-picker-row" key={selector.id}>
      <SearchSelect label={selector.id === itemId ? t('codex.proxy.catalog.nodes') : selector.name} placeholder={t('codex.proxy.catalog.chooseMember')} value={selections[selector.id] ?? ''} disabled={busy}
        options={selector.members.map((name) => {
          const member = source.nodes.find((entry) => entry.name === name) ?? source.groups.find((entry) => entry.name === name);
          return { value: name, label: name, badge: member && 'kind' in member ? policyBadge(member) : undefined,
            detail: member?.supported ? undefined : t(catalogUnsupportedKey(member, name)),
            disabled: (!member?.supported && !isCatalogBlockingMember(name)) || name === selector.name };
        })}
        onChange={(name) => { latency.cancel(); chooseMember(selector.id, name); }} />
    </div>)}
    {!(group?.kind === 'select' && itemId === group.id) && <div className="codex-picker-row"><SearchSelect label={t('codex.proxy.catalog.nodes')} placeholder={t(group ? 'codex.proxy.catalog.groupPolicyChoice' : 'codex.proxy.catalog.nodes')} value={selectedGroup && selectedGroup.id !== groupId ? selectedGroup.id : node?.id ?? ''} disabled={busy}
      options={[
        ...(group ? [{ value: '', label: t('codex.proxy.catalog.groupPolicyChoice'), badge: policyBadge(group) }] : []),
        ...(group ? source.groups.filter((child) => group.members.includes(child.name) && child.id !== group.id).map((child) => ({ value: child.id, label: child.name, badge: policyBadge(child), measure: groupMeasure(child.id), detail: child.supported ? undefined : t(catalogUnsupportedKey(child)) })) : []),
        ...nodes.map((entry) => ({ value: entry.id, label: entry.name, detail: nodeDetail(entry), measure: { label: t('codex.proxy.catalog.check'), disabled: locked || !entry.supported, run: () => latency.measure([entry.id]) }, badge: badge(entry.id), disabled: !entry.supported && !entry.insecure }))
      ]} onChange={(id) => { latency.cancel(); choose(id || groupId, groupId); }} footer={progress} />
    </div>}
    <p className="codex-proxy-page-note">{t(hintKey)}</p>
    {selectedBlockingMember && <div className="codex-picker-network-hint" role="status"><span>{t('codex.proxy.catalog.blockingMemberHint')}</span></div>}
    <ModalErrorMessage message={selectionErrorKey ? t(selectionErrorKey) : null} className="codex-picker-selection-error" scrollKey={`${itemId}:${JSON.stringify(selections)}`} />
    {node?.insecure && setInsecure && <div className="codex-picker-cert"><button type="button" role="switch" aria-checked={node.supported} className={'btn btn-secondary compact' + (node.supported ? ' active' : '')} disabled={locked} onClick={() => setInsecure(node.id, !node.supported)}>{t('codex.proxy.catalog.allowInsecure')}</button><p className="codex-proxy-page-note">{t('codex.proxy.catalog.insecureHint')}</p></div>}
    {dnsSetupErrorKey && <div className="codex-picker-network-hint" role="status"><span>{t(dnsSetupErrorKey)}</span></div>}
    <p className="codex-proxy-page-note">{t('codex.proxy.catalog.latencyNotice')}</p>
    {latency.total > 0 && <div className="codex-resource-progress" role="status"><span>{t('codex.proxy.catalog.measureProgress', { completed: latency.completed, total: latency.total })}</span>
      {latency.running && <button type="button" className="btn btn-secondary compact" onClick={latency.cancel}>{t('common.cancel')}</button>}</div>}
  </div>;
}

import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowRight, Clock3, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CodexAccount } from '../../types/codex';
import { proxyRuntimeRows, proxyRuntimeChanges, proxyRuntimeLabelKey } from '../../utils/codexProxyPreview';
import { useEscCloseTopmost } from '../../hooks/useEscClose';
import { useModalScrollLock } from '../../hooks/useModalScrollLock';
import { useModalFocusTrap } from '../../hooks/useModalFocusTrap';
import { ModalErrorMessage } from '../ModalErrorMessage';
import { useCodexProxyPreview } from './useCodexProxyPreview';
import { CodexProxyActivityPreview } from './CodexProxyActivityPreview';
import { CodexProxyRuntimeDetails, CodexProxyRuntimePort } from './CodexProxyRuntimeDetails';
import { CodexProxyConnectionSummary } from './CodexProxyConnectionSummary';
import '../../styles/pages/codex-proxy-preview.css';

interface Props {
  account: CodexAccount;
  displayName: string;
  onClose: () => void;
  onManage: () => void;
}

/**
 * Read-only egress summary for one account. Selection, checks and binding live on
 * the shared proxy page, so this dialog never becomes a second editing entry.
 */
export function CodexAccountProxyPreview({ account, displayName, onClose, onManage }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const data = useCodexProxyPreview(account.id);
  const [activityView, setActivityView] = useState<'api' | 'proxy'>('api');
  useEscCloseTopmost(true, onClose);
  useModalScrollLock(true);
  useModalFocusTrap(dialog, true);

  const error = [data.statusError ? t('codex.proxy.runtimeUnavailable') : '',
    data.requestsError ? t('codex.proxy.recentFailed') : ''].filter(Boolean).join(' · ');

  return createPortal(<div className="modal-overlay codex-proxy-preview-overlay">
    <div className="modal codex-proxy-preview" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="modal-header">
        <div className="codex-proxy-preview-heading"><span className="codex-proxy-preview-icon"><ShieldCheck size={25} /></span>
          <div><h2 id={titleId}>{t('codex.proxy.previewTitle')}</h2><p>{displayName}</p></div></div>
        <button type="button" className="btn btn-secondary codex-proxy-preview-close" onClick={onClose} aria-label={t('common.close')}><X size={19} /></button>
      </header>
      <div className="modal-body">
        <ModalErrorMessage message={error} />
        <CodexProxyConnectionSummary account={account} status={data.status} failed={data.statusError} />
        <div className="codex-proxy-preview-help"><span>{t('codex.proxy.runtimeHint')}</span></div>
        <section className="codex-proxy-preview-runtime" aria-label={t('codex.proxy.runtimeTitle')}>
          {proxyRuntimeRows(data.status).map((row) => <div key={row.kind}>
            <span>{t(proxyRuntimeLabelKey(row.kind))}</span><strong className={`is-${row.state ?? 'unknown'}`}>
              <i />{row.state ? t(`codex.proxy.runtime_${row.state}`) : data.statusError ? '—' : t('codex.proxy.runtimeLoading')}</strong>
            <small title={row.node || undefined}>{row.node || '—'}</small><CodexProxyRuntimePort row={row} />
            <CodexProxyRuntimeDetails row={row} />
          </div>)}
        </section>
        <div className="codex-proxy-preview-activity">
          <section className="codex-proxy-preview-panel">
            <h3><Clock3 size={17} />{t('codex.proxy.sessionHistory')}<span>{data.history.length}</span></h3>
            <p>{t('codex.proxy.sessionHistoryHint')}</p>
            <ol className="codex-proxy-preview-timeline" tabIndex={0} aria-label={t('codex.proxy.sessionHistory')}>{data.history.map((entry, index) => <li key={`${entry.timestamp}-${index}`}>
              <time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
              <div>{proxyRuntimeChanges(entry.status, data.history[index + 1]?.status).map((row) => <div className="codex-proxy-preview-change" key={row.kind}>
                <span>{t(proxyRuntimeLabelKey(row.kind))}<b>{row.state ? t(`codex.proxy.runtime_${row.state}`) : '—'}</b></span>
                {row.node && <small>{row.node}</small>}{row.port && <CodexProxyRuntimePort row={row} />}
                <CodexProxyRuntimeDetails row={row} />
              </div>)}
              </div></li>)}</ol>
            {data.history.length === 0 && !data.statusError && <p className="codex-proxy-preview-empty">{t('common.loading')}</p>}
          </section>
          <section className="codex-proxy-preview-panel">
            <div className="codex-proxy-preview-activity-switch" role="tablist" aria-label={t('codex.proxy.activity.title')}>
              <button type="button" className={`btn ${activityView === 'api' ? 'is-active' : ''}`} role="tab" aria-selected={activityView === 'api'} onClick={() => setActivityView('api')}><Activity size={15} />{t('codex.proxy.recentTitle')}<span>{data.requests.length}</span></button>
              <button type="button" className={`btn ${activityView === 'proxy' ? 'is-active' : ''}`} role="tab" aria-selected={activityView === 'proxy'} onClick={() => setActivityView('proxy')}>{t('codex.proxy.activity.logs')}</button>
            </div>
            {activityView === 'api' ? <>
              <p>{t('codex.proxy.recentHint')}</p>
              {data.requests.length === 0 ? !data.requestsError && <p className="codex-proxy-preview-empty">{t(data.loading ? 'common.loading' : 'codex.proxy.recentEmpty')}</p>
                : <ol className="codex-proxy-preview-requests" tabIndex={0} aria-label={t('codex.proxy.recentTitle')}>{data.requests.map((request, index) => <li key={`${request.timestamp}-${index}`}>
                  <div><strong>{request.modelId || t('codex.proxy.recentUnknownModel')}</strong><span className={request.success ? 'is-success' : 'is-failure'}>
                    {t(request.success ? 'codex.proxy.recentSuccess' : 'codex.proxy.recentFailure')}{request.httpStatus ? ` · HTTP ${request.httpStatus}` : ''}</span></div>
                  <small><time dateTime={new Date(request.timestamp).toISOString()}>{new Date(request.timestamp).toLocaleString()}</time><span>{Math.max(0, request.latencyMs)} ms</span></small>
                </li>)}</ol>}
            </> : <CodexProxyActivityPreview accountId={account.id} onManage={onManage} />}
          </section>
        </div>
      </div>
      <footer className="modal-footer">
        <button type="button" className="btn btn-secondary" disabled={data.loading} onClick={data.refresh}><RefreshCw size={15} className={data.loading ? 'loading-spinner' : undefined} />{t('common.refresh')}</button>
        <div><button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
          <button type="button" className="btn btn-primary" onClick={onManage}>{t('codex.proxy.management')}<ArrowRight size={16} /></button></div>
      </footer>
    </div>
  </div>, document.body);
}

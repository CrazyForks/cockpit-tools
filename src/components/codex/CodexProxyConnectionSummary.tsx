import { Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CodexProxyRuntimeStatus } from '../../services/codexAccountProxyService';
import { getCodexPlanBadgePresentation, type CodexAccount } from '../../types/codex';
import { proxyPreviewBinding } from '../../utils/codexProxyPreview';
import { proxySummary } from '../../utils/codexProxyPresentation';
import { withCodexPlanBadgeStyle } from '../../utils/codexPreferences';

export function CodexProxyConnectionSummary({ account, status, failed }: {
  account: CodexAccount;
  status: CodexProxyRuntimeStatus | null;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const binding = proxyPreviewBinding(account.egress_proxy, status);
  const saved = binding.summary;
  const rawPlan = account.plan_type?.trim();
  const planClass = rawPlan ? withCodexPlanBadgeStyle(getCodexPlanBadgePresentation(account).className) : '';
  const sourceKey = binding.source === 'account' ? 'codex.proxy.modeIndependent' : binding.source === 'unified'
    ? 'codex.proxy.modeUnified' : binding.source === 'unknown'
      ? failed ? 'codex.proxy.runtimeUnavailable' : 'codex.proxy.runtimeLoading' : 'codex.proxy.filter_unbound';
  return <section className="codex-proxy-preview-connection" aria-label={t('codex.proxy.connectionTitle')}>
    <div className="codex-proxy-preview-node">
      <div className="codex-proxy-preview-eyebrow"><Server size={16} />
        <span className={`codex-proxy-preview-badge${saved ? ' is-bound' : ''}`}>{t(sourceKey)}</span>
        {rawPlan && <span className={`tier-badge ${planClass}`} title={rawPlan}>{rawPlan}</span>}
      </div>
      <h3>{saved?.name || (saved ? proxySummary(saved) : t(binding.source === 'none' ? 'codex.proxy.unboundHint' : sourceKey))}</h3>
      <div className="codex-proxy-preview-metadata">
        {saved?.sourceName && <span>{t('codex.proxy.catalog.sources')}<strong>{saved.sourceName}</strong></span>}
        {saved && !['catalog', 'resource'].includes(saved.protocol.toLowerCase()) && <span>{t('codex.proxy.protocol')}<strong>{saved.protocol.toUpperCase()}</strong></span>}
        {saved?.server && <span>{t('codex.proxy.host')}<strong>{saved.server}{saved.port ? `:${saved.port}` : ''}</strong></span>}
      </div>
      {binding.source === 'unified' && <p>{t('codex.proxy.modeUnifiedHint')}</p>}
      {binding.source === 'none' && <p>{t('codex.proxy.managementHint')}</p>}
    </div>
  </section>;
}

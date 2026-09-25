import { useEffect, useRef, useState } from 'react';
import { cancelProxyCatalog, measureProxyLatency, type ProxyCatalogSource } from '../../services/codexProxyCatalogService';
import { startLatencyBatch, type LatencyState } from '../../utils/codexProxyLatency';
export function useProxyLatency(source: ProxyCatalogSource | undefined) {
  const [results, setResults] = useState<Record<string, LatencyState>>({});
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const active = useRef<ReturnType<typeof startLatencyBatch> | null>(null);
  const generation = useRef(0);
  const key = source ? source.id + ':' + source.revision : '';
  useEffect(() => {
    generation.current++;
    active.current?.cancel(); active.current = null;
    setResults({}); setRunning(false); setTotal(0); setCompleted(0);
    return () => { generation.current++; active.current?.cancel(); active.current = null; };
  }, [key]);
  const measure = (ids: string[]) => {
    if (!source || active.current || !ids.length) return;
    const current = generation.current; const finished = new Set<string>();
    setRunning(true); setTotal(new Set(ids).size); setCompleted(0);
    const batch = startLatencyBatch(ids, {
      id: () => crypto.randomUUID(),
      measure: (nodeId, requestId) => measureProxyLatency(requestId, source.id, nodeId, source.revision),
      cancel: cancelProxyCatalog,
      update: (id, state) => {
        if (generation.current !== current) return;
        setResults((old) => ({ ...old, [id]: state }));
        if (!['queued', 'running'].includes(state.status)) { finished.add(id); setCompleted(finished.size); }
      },
    });
    active.current = batch;
    void batch.done.finally(() => { if (generation.current === current) { active.current = null; setRunning(false); } });
  };
  return { results, running, total, completed, measure, cancel: () => active.current?.cancel() };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, loadHookModule, settlePromises } from '../../../tests/helpers/reactHookHarness';

function editorHarness() {
  const requests: ReturnType<typeof deferred<any>>[] = [];
  const cancelled: string[] = [];
  const accounts = ['A', 'B'].map((id) => ({ id, egress_proxy: { protocol: 'http' } }));
  const store = Object.assign((select: (state: unknown) => unknown) => select({ updateAccountEgressProxy: async () => {} }), {
    getState: () => ({ applyAccountSnapshot() {} }),
  });
  const h = loadHookModule(new URL('./useCodexProxyExitEditor.ts', import.meta.url), {
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    '../../stores/useCodexAccountStore': { useCodexAccountStore: store },
    '../../utils/codexAccountProxy': { canUseCodexAccountProxy: () => true },
    '../../utils/privacy': {},
    '../../services/codexProxyCatalogService': {
      probeProxyCatalog: () => { const request = deferred(); requests.push(request); return request.promise; },
      cancelProxyCatalog: async () => { cancelled.push('catalog'); },
      catalogErrorKey: () => 'catalogProbeFailed',
    },
    '../../services/codexAccountProxyService': {
      testCodexAccountProxy: () => { const request = deferred(); requests.push(request); return request.promise; },
      cancelCodexAccountProxy: async (id: string) => { cancelled.push(id); },
      proxyErrorKey: () => 'probeFailed',
    },
    '../../utils/codexProxySelection': { defaultProxySelections: () => ({}) },
    '../../utils/codexProxyDraft': {
      restoreExitChoice: () => ({ sourceId: '', itemId: '', groupId: '', selections: {} }),
      exitDraftState: (_binding: unknown, _restored: unknown, choice: { itemId: string }) => ({
        bound: true, saved: !choice.itemId, dirty: Boolean(choice.itemId),
      }),
    },
    './CodexProxyWorkspaceContext': { useCodexProxyWorkspace: () => ({ accounts, catalog: {
      sources: [{ id: 'source', nodes: [{ id: 'node', supported: true }], groups: [] }],
    } }) },
  });
  return { ...h, requests, cancelled, select: (id: string) => h.render(() => h.exports.useCodexProxyExitEditor(id)) };
}

for (const fail of [false, true]) {
  test(`switching accounts cancels the old probe and ignores its late ${fail ? 'failure' : 'success'}`, async () => {
    const h = editorHarness();
    h.select('A').test();
    assert.equal(h.flush().busy, 'test');
    assert.equal(h.select('B').busy, '');
    assert.deepEqual(h.cancelled, ['A']);
    h.flush().test();
    assert.equal(h.requests.length, 2);
    if (fail) h.requests[0].reject(new Error('old failure'));
    else h.requests[0].resolve({ ip: 'old' });
    await settlePromises();
    assert.equal(h.flush().busy, 'test');
    assert.equal(h.flush().error, '');
    h.flush().test();
    assert.equal(h.requests.length, 2, 'old finally must not unlock B');
    h.requests[1].resolve({ ip: 'new' });
    await settlePromises();
    assert.equal(h.flush().busy, '');
    assert.equal(h.flush().result.ip, 'new');
    assert.equal(h.select('A').result, undefined);
  });
}

test('unmount cancels a pending probe and reopening starts cleanly', async () => {
  const old = editorHarness(); old.select('A').test(); old.unmount();
  assert.deepEqual(old.cancelled, ['A']);
  const next = editorHarness(); assert.equal(next.select('A').busy, '');
  old.requests[0].reject(new Error('cancelled')); await settlePromises();
  next.flush().test(); assert.equal(next.requests.length, 1);
  next.requests[0].resolve({ ip: 'new' }); await settlePromises();
  assert.equal(next.flush().busy, '');
});

test('switching accounts cancels a draft probe through the catalog and drops its late failure', async () => {
  const h = editorHarness();
  h.select('A').select({ sourceId: 'source', itemId: 'node', groupId: '', selections: {} });
  assert.equal(h.flush().selectionReady, true);
  h.flush().test();
  assert.equal(h.flush().busy, 'test');
  assert.equal(h.select('B').busy, '');
  assert.deepEqual(h.cancelled, ['catalog']);
  h.flush().test();
  h.requests[0].reject(new Error('old draft failed'));
  await settlePromises();
  assert.equal(h.flush().error, '');
  assert.equal(h.flush().busy, 'test');
  h.requests[1].resolve({ ip: 'saved' });
  await settlePromises();
  assert.equal(h.flush().result.ip, 'saved');
  assert.equal(h.flush().resultScope, 'saved');
});

test('returning to the same account still ignores probes from its previous visit', async () => {
  const h = editorHarness();
  h.select('A').test();
  h.select('B').test();
  assert.equal(h.select('A').busy, '');
  h.flush().test();
  assert.deepEqual(h.cancelled, ['A', 'B']);
  assert.equal(h.requests.length, 3);
  h.requests[0].resolve({ ip: 'first A' });
  h.requests[1].resolve({ ip: 'B' });
  await settlePromises();
  assert.equal(h.flush().busy, 'test');
  assert.equal(h.flush().result, undefined);
  h.requests[2].resolve({ ip: 'current A' });
  await settlePromises();
  assert.equal(h.flush().busy, '');
  assert.equal(h.flush().result.ip, 'current A');
});

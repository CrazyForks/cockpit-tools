import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { CodexProxyPicker } from '../components/codex/CodexProxyPicker';
import { defaultProxySelections, proxySelectionGroup, restoreProxySelection, savedRootProxySelections, sourceDefaultDraft } from './codexProxySelection';
import type { ProxyCatalogSource, ProxyCatalogGroup } from '../services/codexProxyCatalogService';
import type { CodexAccount } from '../types/codex';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as selectionUtils from './codexProxySelection';
import * as catalogService from '../services/codexProxyCatalogService';

const group = (id: string, kind: string, members: string[]): ProxyCatalogGroup => ({ id, name: id, kind, members, supported: true, error: null });
const source: ProxyCatalogSource = {
  id: 'subscription', name: 'Example', kind: 'subscription', revision: '1', updatedAt: 0, lastAttemptAt: null, autoUpdate: false, error: null,
  default: null, defaultInvalidated: false,
  nodes: [
    { id: 'node-a', name: 'Alpha', protocol: 'http', supported: true, error: null },
    { id: 'node-b', name: 'Beta', protocol: 'vless', supported: true, error: null },
    { id: 'bad', name: 'Unavailable', protocol: 'vless', supported: false, error: 'PROXY_TLS_INSECURE' },
  ],
  groups: [group('manual', 'select', ['Unavailable', 'Beta', 'Alpha']), group('auto', 'url-test', ['Alpha', 'Beta'])],
};
const saved = (itemId: string): CodexAccount['egress_proxy'] => ({ protocol: 'RESOURCE', sourceId: source.id, itemId });

test('saved source and node restore even when the bound source is not first', () => {
  const catalog = { sources: [{ ...source, id: 'other' }, source] };
  assert.deepEqual(restoreProxySelection(catalog, saved('node-b')), { sourceId: source.id, itemId: 'node-b', groupId: '' });
  assert.equal(proxySelectionGroup(source, 'node-b'), '');
  assert.deepEqual(restoreProxySelection(catalog, saved('auto')), { sourceId: source.id, itemId: 'auto', groupId: 'auto' });
  assert.equal(proxySelectionGroup(source, 'auto'), 'auto');
});

test('async catalog load restores saved identity without using another account or draft', () => {
  assert.deepEqual(restoreProxySelection({ sources: [] }, saved('node-b')), { sourceId: '', itemId: '', groupId: '' });
  assert.equal(restoreProxySelection({ sources: [source] }, saved('node-b')).itemId, 'node-b');
  assert.equal(restoreProxySelection({ sources: [source] }, saved('node-a')).itemId, 'node-a');
  assert.deepEqual(restoreProxySelection({ sources: [source] }, null), { sourceId: source.id, itemId: '', groupId: '' });
});

test('missing resources never silently select a substitute; unsupported saved nodes still display', () => {
  const catalog = { sources: [source] };
  assert.deepEqual(restoreProxySelection(catalog, { ...saved('node-a')!, sourceId: 'deleted' }), { sourceId: '', itemId: '', groupId: '' });
  assert.deepEqual(restoreProxySelection(catalog, saved('deleted')), { sourceId: source.id, itemId: '', groupId: '' });
  assert.equal(restoreProxySelection(catalog, saved('bad')).itemId, 'bad');
  assert.equal(defaultProxySelections(source, 'bad'), null);
});

test('manual group binding requires an explicit supported member without changing the source', () => {
  const original = JSON.stringify(source);
  assert.equal(defaultProxySelections(source, 'manual'), null);
  assert.deepEqual(defaultProxySelections(source, 'manual', { manual: 'Beta' }), { manual: 'Beta' });
  assert.equal(defaultProxySelections(source, 'manual', { manual: 'Unavailable' }), null);
  assert.equal(defaultProxySelections(source, 'manual', { manual: 'missing' }), null);
  assert.deepEqual(defaultProxySelections(source, 'node-a'), {});
  assert.equal(JSON.stringify(source), original);
});

test('automatic, fallback and balancing groups require choices for nested manual groups', () => {
  for (const kind of ['url-test', 'fallback', 'load-balance']) {
    const nested = { ...source, groups: [group('root', kind, ['manual', 'Alpha']), ...source.groups] };
    assert.equal(defaultProxySelections(nested, 'root'), null);
    assert.deepEqual(defaultProxySelections(nested, 'root', { manual: 'Beta' }), { manual: 'Beta' });
  }
  assert.deepEqual(defaultProxySelections(source, 'auto'), {});
});

test('automatic groups preserve blocking members, without allowing direct routing or standalone built-ins', () => {
  for (const kind of ['url-test', 'fallback', 'load-balance']) {
    const supported = { ...source, groups: [group('root', kind, ['REJECT', 'Alpha', 'REJECT-DROP'])] };
    assert.deepEqual(defaultProxySelections(supported, 'root'), {});
    for (const name of ['DIRECT', 'PASS', 'PASS-RULE', 'COMPATIBLE', 'missing']) {
      const unavailable = { ...source, groups: [group('root', kind, ['Alpha', name])] };
      assert.equal(defaultProxySelections(unavailable, 'root'), null, `${kind} must not accept ${name}`);
    }
  }
  for (const name of ['REJECT', 'REJECT-DROP', 'DIRECT', 'PASS', 'PASS-RULE', 'COMPATIBLE']) {
    assert.equal(defaultProxySelections(source, name), null);
    const builtInNode = { ...source, nodes: [{ id: 'fake-node', name, protocol: 'http', supported: true, error: null }] };
    assert.equal(defaultProxySelections(builtInNode, 'fake-node'), null, 'reserved rules never become standalone nodes');
  }
});

test('manual groups keep explicit blocking choices but reject bypass rules and unsupported members', () => {
  const manual = { ...source, groups: [group('root', 'select', ['REJECT', 'REJECT-DROP', 'DIRECT', 'PASS', 'PASS-RULE', 'COMPATIBLE', 'Unavailable', 'Alpha'])] };
  for (const name of ['REJECT', 'REJECT-DROP']) {
    assert.deepEqual(defaultProxySelections(manual, 'root', { root: name }), { root: name });
  }
  for (const name of ['DIRECT', 'PASS', 'PASS-RULE', 'COMPATIBLE', 'Unavailable']) {
    assert.equal(defaultProxySelections(manual, 'root', { root: name }), null);
  }
  assert.equal(defaultProxySelections({ ...manual, groups: [{ ...manual.groups[0], supported: false, error: 'SUBSCRIPTION_GROUP_OPTIONS' }] }, 'root', { root: 'REJECT' }), null);
});

test('nested manual groups resolve reachable choices, excluding unrelated selectors', () => {
  const nested = { ...source, groups: [group('root', 'select', ['auto']), group('unrelated', 'select', []), ...source.groups] };
  assert.equal(defaultProxySelections(nested, 'root'), null);
  assert.deepEqual(defaultProxySelections(nested, 'root', { root: 'auto' }), { root: 'auto' });
});

test('cycles and unavailable groups fail closed without direct fallback', () => {
  assert.equal(defaultProxySelections({ ...source, groups: [group('cycle', 'select', ['cycle'])] }, 'cycle'), null);
  assert.equal(defaultProxySelections({ ...source, groups: [group('empty', 'select', ['DIRECT', 'Unavailable'])] }, 'empty'), null);
  assert.equal(defaultProxySelections({ ...source, groups: [group('bad-auto', 'url-test', ['Unavailable', 'Alpha'])] }, 'bad-auto'), null);
  assert.equal(defaultProxySelections(source, 'missing'), null);
  assert.deepEqual(defaultProxySelections({ ...source, groups: [group('cycle', 'select', ['cycle', 'Alpha'])] }, 'cycle', { cycle: 'Alpha' }), { cycle: 'Alpha' });
  assert.equal(defaultProxySelections({ ...source, groups: [group('cycle', 'select', ['cycle', 'Alpha'])] }, 'cycle', { cycle: 'cycle' }), null);
});

test('saved manual member can be restored for display without choosing another member', () => {
  assert.deepEqual(savedRootProxySelections(source, { ...saved('manual')!, selectedName: 'Beta' }), { manual: 'Beta' });
  assert.deepEqual(savedRootProxySelections(source, { ...saved('manual')!, selectedName: 'missing' }), {});
});

test('a source default only prefills a resolvable draft and never invents a choice', () => {
  const withDefault = (itemId: string, selections: Record<string, string> = {}, groupId: string | null = null) =>
    ({ ...source, default: { itemId, groupId, selections }, defaultInvalidated: false });
  assert.equal(sourceDefaultDraft(undefined), null);
  assert.equal(sourceDefaultDraft(source), null);
  assert.deepEqual(sourceDefaultDraft(withDefault('node-b', {}, 'auto')), { itemId: 'node-b', groupId: 'auto', selections: {} });
  assert.deepEqual(sourceDefaultDraft(withDefault('manual', { manual: 'Beta' })), { itemId: 'manual', groupId: 'manual', selections: { manual: 'Beta' } });
  assert.equal(sourceDefaultDraft(withDefault('manual')), null, '手动组没有成员时不得自动挑选');
  assert.equal(sourceDefaultDraft(withDefault('manual', { manual: 'Unavailable' })), null);
  assert.equal(sourceDefaultDraft(withDefault('bad')), null, '已失效节点不得带入草稿');
  assert.equal(sourceDefaultDraft(withDefault('deleted')), null, '已删除节点不得静默替换');
  assert.equal(sourceDefaultDraft(withDefault('node-b', {}, 'removed'))?.groupId, '', '过期的分组上下文不得继续使用');
  assert.equal(sourceDefaultDraft(withDefault('auto'))?.groupId, 'auto');
});

test('default commands keep the IPC contract for source ids, item ids and member choices', async () => {
  const calls: unknown[] = [];
  const compiledService = ts.transpileModule(readFileSync(new URL('../services/codexProxyCatalogService.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiledService, {
    exports, setTimeout, clearTimeout,
    require: () => ({ invoke: async (command: string, args?: unknown) => { calls.push({ command, args }); return { sources: [] }; } }),
  });
  await exports.setProxyCatalogDefault('subscription', 'manual', { manual: 'Beta' });
  await exports.setProxyCatalogDefault('subscription', 'node-b', {}, 'auto');
  await exports.clearProxyCatalogDefault('subscription');
  // Cross-realm objects keep sandbox prototypes, so compare the serialized contract.
  assert.equal(JSON.stringify(calls), JSON.stringify([
    { command: 'codex_proxy_catalog_set_default', args: { sourceId: 'subscription', itemId: 'manual', selections: { manual: 'Beta' } } },
    { command: 'codex_proxy_catalog_set_default', args: { sourceId: 'subscription', itemId: 'node-b', selections: {}, groupId: 'auto' } },
    { command: 'codex_proxy_catalog_clear_default', args: { sourceId: 'subscription' } },
  ]));
});

test('picker renders restored node and group policy without summary, policy button or breadcrumb', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: { codex: { proxy: { catalog: {
    groups: 'Groups', nodes: 'Nodes', groupPolicyChoice: 'Group policy', measureGroup: 'Test group',
  } } } } } } });
  const latency = { results: {}, running: false, total: 0, completed: 0, measure: () => {}, cancel: () => {} };
  const render = (itemId: string) => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
    createElement(CodexProxyPicker, { source, itemId, selectedGroupId: 'manual', selections: {}, busy: false, latency, choose: () => {}, chooseMember: () => {} })));
  const nodeHtml = render('node-b');
  assert.match(nodeHtml, /<span>manual<\/span>/);
  assert.match(nodeHtml, /<span>Beta<\/span>/);
  assert.match(nodeHtml, /aria-label="Test group"/);
  assert.doesNotMatch(nodeHtml, /codex-picker-summary|codex-picker-path|useGroupPolicy|chooseMember/);
  const groupHtml = render('auto');
  assert.match(groupHtml, /<span>auto<\/span>/);
  assert.match(groupHtml, /<span>Group policy<\/span>/);
});

test('picker keeps manual group identity while choosing its member; standalone nodes remain separate', () => {
  // Exercise component event handlers without a browser or GUI automation.
  const compiled = ts.transpileModule(readFileSync(new URL('../components/codex/CodexProxyPicker.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const hooks: unknown[] = []; let cursor = 0;
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled, { exports, require: (name: string) => {
    if (name === 'react') return {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
        return [hooks[index], (value: unknown) => { hooks[index] = value; }];
      },
      useMemo: (fn: () => unknown) => fn(), useEffect: () => {},
    };
    if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) };
    if (name === 'react-i18next') return { useTranslation: () => ({ t: (key: string) => key }) };
    if (name.endsWith('codexProxyCatalogService')) return catalogService;
    if (name.endsWith('codexProxySelection')) return selectionUtils;
    return {};
  } });
  let itemId = ''; let selectedGroupId = ''; let selections: Record<string, string> = {}; const chosen: string[] = []; const measurements: string[][] = [];
  const latency = { results: {}, running: false, total: 0, completed: 0, measure: (ids: string[]) => measurements.push(ids), cancel: () => {} };
  const render = () => {
    cursor = 0;
    return exports.CodexProxyPicker({ source, itemId, selectedGroupId, selections, busy: false, latency,
      choose: (id: string, nextGroup: string) => { itemId = id; selectedGroupId = nextGroup; selections = {}; chosen.push(id); },
      chooseMember: (groupId: string, member: string) => { selections = { ...selections, [groupId]: member }; } });
  };
  let rows = render().props.children;
  rows[0].props.children[0].props.onChange('manual');
  assert.equal(itemId, 'manual');
  assert.equal(defaultProxySelections(source, itemId, selections), null);
  rows = render().props.children;
  assert.equal(rows[0].props.children[0].props.value, 'manual');
  rows[0].props.children[1].props.onClick();
  assert.deepEqual(measurements, [['node-b', 'node-a']]);
  assert.deepEqual(chosen, ['manual']);
  rows[1][0].props.children.props.onChange('Beta');
  assert.equal(itemId, 'manual');
  assert.deepEqual(defaultProxySelections(source, itemId, selections), { manual: 'Beta' });
  rows[0].props.children[0].props.onChange('');
  rows = render().props.children;
  rows[2].props.children.props.onChange('node-a');
  assert.equal(itemId, 'node-a');
  rows = render().props.children;
  assert.equal(rows[2].props.children.props.value, 'node-a');
  assert.deepEqual(defaultProxySelections(source, itemId, selections), {});
});

test('shared nodes restore the recorded group, independent of subscription order', () => {
  const binding = { ...saved('node-b')!, groupId: 'auto' };
  assert.equal(restoreProxySelection({ sources: [source] }, binding).groupId, 'auto');
  assert.equal(proxySelectionGroup({ ...source, groups: [...source.groups].reverse() }, 'node-b', 'manual'), 'manual');
  assert.equal(proxySelectionGroup(source, 'node-b'), '');
  assert.equal(proxySelectionGroup(source, 'node-b', 'removed'), '');
  assert.equal(proxySelectionGroup({ ...source, groups: [group('auto', 'url-test', ['Alpha'])] }, 'node-b', 'auto'), '');
  assert.equal(proxySelectionGroup(source, 'auto'), 'auto');
});

test('a chosen subgroup restores its explicit parent for editing and source defaults', () => {
  const nested = { ...source, groups: [group('region', 'url-test', ['auto', 'Alpha']), group('other-region', 'select', ['auto']), ...source.groups] };
  const binding = { ...saved('auto')!, groupId: 'region' };
  assert.deepEqual(restoreProxySelection({ sources: [nested] }, binding), { sourceId: source.id, itemId: 'auto', groupId: 'region' });
  assert.equal(proxySelectionGroup(nested, 'auto', 'other-region'), 'other-region');
  assert.equal(proxySelectionGroup(nested, 'auto', 'missing'), 'auto');
  assert.equal(proxySelectionGroup(nested, 'auto', 'manual'), 'auto', 'unrelated groups cannot replace the parent');
  assert.deepEqual(sourceDefaultDraft({ ...nested, default: { itemId: 'auto', groupId: 'region', selections: {} } }), {
    itemId: 'auto', groupId: 'region', selections: {},
  });
});

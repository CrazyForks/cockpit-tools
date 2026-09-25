import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { loadHookModule } from '../../../tests/helpers/reactHookHarness';
import { CodexProxyPicker } from './CodexProxyPicker';
import * as catalogService from '../../services/codexProxyCatalogService';
import * as selectionUtils from '../../utils/codexProxySelection';
import type { ProxyCatalogGroup, ProxyCatalogSource } from '../../services/codexProxyCatalogService';
import en from '../../locales/en-US.json';

const group = (id: string, name: string, kind: string, members: string[]): ProxyCatalogGroup => ({ id, name, kind, members, supported: true, error: null });
const source: ProxyCatalogSource = {
  id: 'source', name: 'Example', kind: 'subscription', revision: '1', updatedAt: 0, lastAttemptAt: null,
  autoUpdate: false, error: null, default: null, defaultInvalidated: false,
  nodes: [{ id: 'us', name: 'US node', protocol: 'http', supported: true, error: null }],
  groups: [group('region', 'US group', 'select', ['Automatic', 'US node', 'REJECT', 'REJECT-DROP', 'DIRECT', 'PASS', 'PASS-RULE', 'COMPATIBLE']),
    group('auto', 'Automatic', 'url-test', ['US node', 'REJECT']),
    { ...group('unsupported', 'Unsupported group', 'url-test', ['US node', 'Missing']), supported: false, error: 'SUBSCRIPTION_GROUP_UNAVAILABLE' }],
};
const latency = { results: {}, running: false, total: 0, completed: 0, measure: () => {}, cancel: () => {} };

async function markup(data: ProxyCatalogSource, itemId: string, selectedGroupId: string, selections: Record<string, string> = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(CodexProxyPicker, {
    source: data, itemId, selectedGroupId, selections, busy: false, latency, choose: () => {}, chooseMember: () => {},
  })));
}

function elements(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}

test('selecting an automatic member renders its name, policy and parent without requiring a node', async () => {
  const html = await markup(source, 'region', 'region', { region: 'Automatic' });
  assert.match(html, /<span>US group<\/span>/);
  assert.match(html, /<span>Automatic<\/span>/);
  assert.match(html, /Lowest latency/);
  assert.match(html, /Use the whole group without pinning a node/);
  assert.doesNotMatch(html, /No specific node|role="alert"/);
  assert.deepEqual(selectionUtils.defaultProxySelections(source, 'region', { region: 'Automatic' }), { region: 'Automatic' });
});

test('a directly selected child policy retains the parent group and child name after restoration', async () => {
  const data = { ...source, groups: [{ ...source.groups[0], kind: 'fallback' }, ...source.groups.slice(1)] };
  const html = await markup(data, 'auto', 'region');
  assert.match(html, /<span>US group<\/span>/);
  assert.match(html, /<span>Automatic<\/span>/);
  assert.match(html, /Lowest latency/);
  assert.doesNotMatch(html, /<span>Group policy<\/span>/);
  assert.deepEqual(selectionUtils.defaultProxySelections(data, 'auto'), {});
});

test('an unavailable group displays a sanitized inline reason; choosing a valid node clears it', async () => {
  const invalid = await markup(source, 'unsupported', 'unsupported');
  assert.match(invalid, /role="alert"/);
  assert.match(invalid, /Group members are unavailable or form a cycle/);
  const unsafe = { ...source, groups: [{ ...source.groups[2], error: 'https://private.invalid/?token=secret' }] };
  const sanitized = await markup(unsafe, 'unsupported', 'unsupported');
  assert.doesNotMatch(sanitized, /private\.invalid|token=secret/);
  assert.match(sanitized, /This configuration is unavailable/);
  const valid = await markup(source, 'us', 'region');
  assert.doesNotMatch(valid, /role="alert"/);
  assert.doesNotMatch(valid, /Use the whole group without pinning a node/);
});

test('an explicit blocking member keeps its explanation visible after the menu closes and clears on a node choice', async () => {
  for (const member of ['REJECT', 'REJECT-DROP']) {
    const html = await markup(source, 'region', 'region', { region: member });
    assert.match(html, /role="status"/);
    assert.match(html, /This member blocks requests without falling back to a direct connection/);
    assert.doesNotMatch(html, /role="alert"/);
    assert.deepEqual(selectionUtils.defaultProxySelections(source, 'region', { region: member }), { region: member });
  }
  const valid = await markup(source, 'region', 'region', { region: 'US node' });
  assert.doesNotMatch(valid, /This member blocks requests/);
  const automatic = await markup(source, 'region', 'region', { region: 'Automatic' });
  assert.doesNotMatch(automatic, /This member blocks requests/, 'a blocking candidate in an automatic group is not an explicit block');
  const bypass = await markup(source, 'region', 'region', { region: 'PASS-RULE' });
  assert.match(bypass, /role="alert"/);
  assert.equal(selectionUtils.defaultProxySelections(source, 'region', { region: 'PASS-RULE' }), null);
});

test('picker handlers retain a child policy identity and never silently choose a leaf node', () => {
  const data = { ...source, groups: [{ ...source.groups[0], kind: 'fallback' }, ...source.groups.slice(1)] };
  const h = loadHookModule(new URL('./CodexProxyPicker.tsx', import.meta.url), {
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    '../../services/codexProxyCatalogService': catalogService,
    '../../utils/codexProxySelection': selectionUtils,
    '../ModalErrorMessage': { ModalErrorMessage: () => null },
  });
  let itemId = 'region'; let selectedGroupId = 'region';
  const props = () => ({ source: data, itemId, selectedGroupId, selections: {}, busy: false, latency,
    choose: (id: string, parent: string) => { itemId = id; selectedGroupId = parent; }, chooseMember: () => {},
  });
  const selects = () => elements(h.render(() => h.exports.CodexProxyPicker(props())))
    .filter((entry) => entry.type?.name === 'SearchSelect');
  const picker = selects();
  picker[1].props.onChange('auto');
  assert.equal(itemId, 'auto');
  assert.equal(selectedGroupId, 'region');
  const selected = selects();
  assert.equal(selected[0].props.value, 'region');
  assert.equal(selected[1].props.value, 'auto');
  selected[1].props.onChange('');
  assert.equal(itemId, 'region');
  assert.equal(selectedGroupId, 'region');
  h.unmount();
});

test('manual member options allow explicit blocking rules but keep every bypass rule disabled', () => {
  const h = loadHookModule(new URL('./CodexProxyPicker.tsx', import.meta.url), {
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    '../../services/codexProxyCatalogService': catalogService,
    '../../utils/codexProxySelection': selectionUtils,
    '../ModalErrorMessage': { ModalErrorMessage: () => null },
  });
  const tree = h.render(() => h.exports.CodexProxyPicker({ source, itemId: 'region', selectedGroupId: 'region', selections: {}, busy: false, latency, choose: () => {}, chooseMember: () => {} }));
  const selectors = elements(tree).filter((entry) => entry.type?.name === 'SearchSelect');
  const options = selectors[1].props.options;
  for (const name of ['REJECT', 'REJECT-DROP']) {
    const option = options.find((entry: any) => entry.value === name);
    assert.equal(option.disabled, false);
    assert.equal(option.detail, 'codex.proxy.catalog.blockingMemberHint');
  }
  for (const name of ['DIRECT', 'PASS', 'PASS-RULE', 'COMPATIBLE']) assert.equal(options.find((entry: any) => entry.value === name).disabled, true);
  h.unmount();
});

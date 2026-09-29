/**
 * 账号分组管理弹窗
 * - 创建 / 重命名 / 删除分组
 * - 显示分组列表及账号数量
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FolderOpen, Plus, Pencil, Trash2, FolderPlus, AlertCircle, GripVertical, ChevronUp, ChevronDown, Search } from 'lucide-react';
import {
  AccountGroup,
  getPlatformGroups,
  createPlatformGroup,
  deletePlatformGroup,
  renamePlatformGroup,
  assignAccountsToPlatformGroup,
  setPlatformGroupAccounts,
  reorderPlatformGroups,
  normalizePlatform,
} from '../services/platformGroupService';
import { invalidateCache as invalidateLegacyCache } from '../services/accountGroupService';
import { listAccounts } from '../services/accountService';
import { getAntigravityTierBadge } from '../utils/account';
import { useEscClose } from '../hooks/useEscClose';
import './AccountGroupModal.css';
import './GroupAccountPickerModal.css';

function getGroupIndexAtPoint(clientX: number, clientY: number, container: HTMLElement | null): number | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (element) {
    const itemElement = element.closest('[data-group-index]');
    if (itemElement) {
      const idx = Number(itemElement.getAttribute('data-group-index'));
      if (!isNaN(idx)) return idx;
    }
  }
  if (container) {
    const items = container.querySelectorAll<HTMLElement>('[data-group-index]');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        const idx = Number(item.getAttribute('data-group-index'));
        if (!isNaN(idx)) return idx;
      }
    }
    if (items.length > 0) {
      const firstRect = items[0].getBoundingClientRect();
      if (clientY < firstRect.top) return 0;
      const lastRect = items[items.length - 1].getBoundingClientRect();
      if (clientY > lastRect.bottom) return items.length - 1;
    }
  }
  return null;
}

// ─── 分组管理弹窗 ──────────────────────────────────────────

interface AccountGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGroupsChanged: () => Promise<void> | void;
  /** 平台标识（默认 antigravity） */
  platform?: string;
  /** 当前被勾选用于筛选的分组 ID 列表 */
  groupFilter?: string[];
  /** 切换某个分组的筛选状态 */
  onToggleGroupFilter?: (groupId: string) => void;
  /** 清空分组筛选 */
  onClearGroupFilter?: () => void;
  /** 点击添加账号回调（可选，优先由外部处理；若未提供则使用内置通用账号选择器） */
  onAddAccounts?: (group: AccountGroup) => void;
  /** 可选账号列表（用于通用添加账号弹窗） */
  accounts?: Array<{ id: string; [key: string]: any }>;
}

export const AccountGroupModal = ({
  isOpen, onClose, onGroupsChanged, platform,
  onAddAccounts, accounts,
}: AccountGroupModalProps) => {
  const { t } = useTranslation();
  useEscClose(isOpen, onClose);
  const platformKey = normalizePlatform(platform || 'antigravity');
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerTargetGroup, setPickerTargetGroup] = useState<AccountGroup | null>(null);
  const [loadedAccounts, setLoadedAccounts] = useState<Array<{ id: string; [key: string]: any }>>([]);

  const listRef = useRef<HTMLDivElement>(null);
  const dragSourceIndexRef = useRef<number | null>(null);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setGroups(await getPlatformGroups(platformKey));
  }, [platformKey]);

  useEffect(() => {
    if (accounts && accounts.length > 0) {
      setLoadedAccounts(accounts);
    } else if (platformKey === 'antigravity' && isOpen) {
      listAccounts().then((accs) => setLoadedAccounts(accs)).catch(console.error);
    } else {
      setLoadedAccounts(accounts || []);
    }
  }, [accounts, platformKey, isOpen]);

  useEffect(() => {
    if (isOpen) {
      reload();
      setNewName('');
      setRenamingId(null);
      setDeleteConfirmId(null);
      setPickerTargetGroup(null);
      dragSourceIndexRef.current = null;
      dragStartPosRef.current = null;
      setDraggingIndex(null);
      setDragOverIndex(null);
      setError(null);
    }
  }, [isOpen, reload]);

  const handleItemPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    if (renamingId !== null) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, .group-actions, .group-filter-checkbox')) {
      return;
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    dragSourceIndexRef.current = index;
    dragStartPosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleItemPointerMove = (e: React.PointerEvent) => {
    if (dragSourceIndexRef.current === null || !dragStartPosRef.current) return;
    const dist = Math.hypot(e.clientX - dragStartPosRef.current.x, e.clientY - dragStartPosRef.current.y);
    if (dist > 4) {
      if (draggingIndex === null) {
        setDraggingIndex(dragSourceIndexRef.current);
      }
      const idx = getGroupIndexAtPoint(e.clientX, e.clientY, listRef.current);
      if (idx !== null && idx !== dragOverIndex) {
        setDragOverIndex(idx);
      }
    }
  };

  const handleItemPointerUp = async (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    const sourceIdx = dragSourceIndexRef.current;
    const targetIdx = dragOverIndex;

    dragSourceIndexRef.current = null;
    dragStartPosRef.current = null;
    setDraggingIndex(null);
    setDragOverIndex(null);

    if (sourceIdx !== null && targetIdx !== null && sourceIdx !== targetIdx && targetIdx >= 0 && targetIdx < groups.length) {
      const nextGroups = [...groups];
      const [moved] = nextGroups.splice(sourceIdx, 1);
      nextGroups.splice(targetIdx, 0, moved);
      setGroups(nextGroups);
      try {
        await reorderPlatformGroups(platformKey, nextGroups.map((g) => g.id));
        if (platformKey === 'antigravity') {
          invalidateLegacyCache();
        }
        await onGroupsChanged();
      } catch (err) {
        console.error('Failed to reorder groups:', err);
        await reload();
      }
    }
  };

  const handleItemPointerCancel = (e: React.PointerEvent) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    dragSourceIndexRef.current = null;
    dragStartPosRef.current = null;
    setDraggingIndex(null);
    setDragOverIndex(null);
  };

  const handleMove = async (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= groups.length) return;
    const nextGroups = [...groups];
    const temp = nextGroups[index];
    nextGroups[index] = nextGroups[targetIndex];
    nextGroups[targetIndex] = temp;
    setGroups(nextGroups);
    try {
      await reorderPlatformGroups(platformKey, nextGroups.map((g) => g.id));
      if (platformKey === 'antigravity') {
        invalidateLegacyCache();
      }
      await onGroupsChanged();
    } catch (err) {
      console.error('Failed to move group:', err);
      await reload();
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      // 重名检查
      if (groups.some((g) => g.name === name)) {
        setError(t('accounts.groups.error.duplicate'));
        return;
      }
      await createPlatformGroup(platformKey, name);
      if (platformKey === 'antigravity') {
        invalidateLegacyCache();
      }
      setNewName('');
      await reload();
      await onGroupsChanged();
    } catch (err) {
      console.error('Failed to create group:', err);
      setError(t('accounts.groups.error.createFailed', {
        error: String(err),
      }));
    }
  };

  const handleRename = async (groupId: string) => {
    const name = renameValue.trim();
    if (!name) return;
    setError(null);
    try {
      // 重名检查（排除自己）
      if (groups.some((g) => g.id !== groupId && g.name === name)) {
        setError(t('accounts.groups.error.duplicate'));
        return;
      }
      await renamePlatformGroup(platformKey, groupId, name);
      if (platformKey === 'antigravity') {
        invalidateLegacyCache();
      }
      setRenamingId(null);
      await reload();
      await onGroupsChanged();
    } catch (err) {
      console.error('Failed to rename group:', err);
      setError(t('accounts.groups.error.renameFailed', {
        error: String(err),
      }));
    }
  };

  const handleDelete = async (groupId: string) => {
    setError(null);
    try {
      await deletePlatformGroup(platformKey, groupId);
      if (platformKey === 'antigravity') {
        invalidateLegacyCache();
      }
      setDeleteConfirmId(null);
      await reload();
      await onGroupsChanged();
    } catch (err) {
      console.error('Failed to delete group:', err);
      setError(t('accounts.groups.error.deleteFailed', {
        error: String(err),
      }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal account-group-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <FolderOpen size={18} />
            {t('accounts.groups.manageTitle')}
          </h2>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* 创建分组 */}
          <div className="group-create-row">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder={t('accounts.groups.newPlaceholder')}
              maxLength={30}
            />
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              disabled={!newName.trim()}
            >
              <Plus size={14} />
              {t('accounts.groups.create')}
            </button>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="group-modal-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          {/* 分组列表 */}
          {groups.length === 0 ? (
            <div className="group-modal-empty">
              <FolderPlus size={36} />
              <div>{t('accounts.groups.empty')}</div>
            </div>
          ) : (
            <div className="group-modal-list" ref={listRef}>
              {groups.map((group, index) => (
                <div
                  key={group.id}
                  data-group-index={index}
                  className={`group-modal-item ${draggingIndex === index ? 'is-dragging' : ''} ${dragOverIndex === index && draggingIndex !== null && draggingIndex !== index ? 'drop-target' : ''}`}
                  onPointerDown={(e) => handleItemPointerDown(e, index)}
                  onPointerMove={handleItemPointerMove}
                  onPointerUp={handleItemPointerUp}
                  onPointerCancel={handleItemPointerCancel}
                >
                  <div className="group-modal-item-main">
                    {/* 拖动手柄 */}
                    <div
                      className="group-drag-handle"
                      title={t('accounts.groups.dragToSort', '按住拖动排序')}
                    >
                      <GripVertical size={14} />
                    </div>

                    <FolderOpen size={18} className="group-icon" />
                    <div className="group-info">
                      {renamingId === group.id ? (
                        <input
                          className="group-rename-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRename(group.id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onBlur={() => handleRename(group.id)}
                          autoFocus
                          maxLength={30}
                        />
                      ) : (
                        <>
                          <span className="group-name">{group.name}</span>
                          <span className="group-count">
                            {t('accounts.groups.accountCount', {
                              count: group.accountIds.length,
                            })}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="group-actions">
                      {deleteConfirmId === group.id ? (
                        <>
                          <button
                            className="group-action-btn danger"
                            onClick={() => handleDelete(group.id)}
                            title={t('common.confirm')}
                          >
                            ✓
                          </button>
                          <button
                            className="group-action-btn"
                            onClick={() => setDeleteConfirmId(null)}
                            title={t('common.cancel')}
                          >
                            ✗
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="group-action-btn add-btn"
                            onClick={() => {
                              if (onAddAccounts) {
                                onAddAccounts(group);
                              } else {
                                setPickerTargetGroup(group);
                              }
                            }}
                            title={t('accounts.groups.addAccounts', '添加账号')}
                          >
                            <FolderPlus size={14} />
                            <span>{t('accounts.groups.addAccounts', '添加账号')}</span>
                          </button>
                          <button
                            type="button"
                            className="group-action-btn"
                            disabled={index === 0}
                            onClick={() => handleMove(index, 'up')}
                            title={t('accounts.groups.moveUp', '上移')}
                          >
                            <ChevronUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="group-action-btn"
                            disabled={index === groups.length - 1}
                            onClick={() => handleMove(index, 'down')}
                            title={t('accounts.groups.moveDown', '下移')}
                          >
                            <ChevronDown size={14} />
                          </button>
                          <button
                            className="group-action-btn"
                            onClick={() => {
                              setRenamingId(group.id);
                              setRenameValue(group.name);
                            }}
                            title={t('accounts.groups.rename')}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="group-action-btn danger"
                            onClick={() => setDeleteConfirmId(group.id)}
                            title={t('common.delete')}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>

      <UniversalGroupAccountPickerModal
        isOpen={!!pickerTargetGroup}
        targetGroup={pickerTargetGroup}
        accounts={loadedAccounts}
        accountGroups={groups}
        platform={platformKey}
        onClose={() => setPickerTargetGroup(null)}
        onConfirm={async ({ accountIds }) => {
          if (!pickerTargetGroup) return;
          await setPlatformGroupAccounts(
            platformKey,
            pickerTargetGroup.id,
            accountIds
          );
          if (platformKey === 'antigravity') {
            invalidateLegacyCache();
          }
          await reload();
          await onGroupsChanged();
        }}
      />
    </div>
  );
};

// ─── 通用添加账号到分组弹窗 ──────────────────────────────────

export interface UniversalGroupAccountPickerModalProps {
  isOpen: boolean;
  targetGroup: AccountGroup | null;
  accounts: Array<{ id: string; [key: string]: any }>;
  accountGroups: AccountGroup[];
  platform?: string;
  onClose: () => void;
  onConfirm: (payload: { accountIds: string[] }) => Promise<void> | void;
}

export function UniversalGroupAccountPickerModal({
  isOpen,
  targetGroup,
  accounts,
  accountGroups,
  onClose,
  onConfirm,
}: UniversalGroupAccountPickerModalProps) {
  const { t } = useTranslation();
  useEscClose(isOpen, onClose);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen || !targetGroup) return;
    setQuery('');
    const validIds = new Set(accounts.map((a) => a.id));
    setSelected(new Set((targetGroup.accountIds || []).filter((id) => validIds.has(id))));
    setError('');
  }, [isOpen, targetGroup, accounts]);

  const groupsByAccountId = useMemo(() => {
    const result = new Map<string, AccountGroup[]>();
    for (const group of accountGroups) {
      for (const accountId of group.accountIds) {
        const list = result.get(accountId) || [];
        list.push(group);
        result.set(accountId, list);
      }
    }
    return result;
  }, [accountGroups]);

  const visibleAccounts = useMemo(() => {
    if (!targetGroup) return [];
    const queryText = query.trim().toLowerCase();
    let next = [...accounts].sort((a, b) => {
      const aName = (a.email || a.name || a.id || '').toLowerCase();
      const bName = (b.email || b.name || b.id || '').toLowerCase();
      return aName.localeCompare(bName);
    });

    if (!queryText) return next;

    return next.filter((account) => {
      const email = (account.email || '').toLowerCase();
      const name = (account.name || account.displayName || account.username || '').toLowerCase();
      const groupNames = (groupsByAccountId.get(account.id) || [])
        .map((g) => g.name.toLowerCase())
        .join(' ');
      return (
        email.includes(queryText) ||
        name.includes(queryText) ||
        account.id.toLowerCase().includes(queryText) ||
        groupNames.includes(queryText)
      );
    });
  }, [accounts, groupsByAccountId, query, targetGroup]);

  const selectedVisibleCount = useMemo(
    () =>
      visibleAccounts.reduce(
        (count, account) => count + (selected.has(account.id) ? 1 : 0),
        0
      ),
    [selected, visibleAccounts]
  );

  const allVisibleSelected =
    visibleAccounts.length > 0 && selectedVisibleCount === visibleAccounts.length;

  useEffect(() => {
    if (!selectAllCheckboxRef.current) return;
    selectAllCheckboxRef.current.indeterminate =
      selectedVisibleCount > 0 && !allVisibleSelected;
  }, [allVisibleSelected, selectedVisibleCount]);

  const toggleSelectAllVisible = () => {
    if (saving || visibleAccounts.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const account of visibleAccounts) {
          next.delete(account.id);
        }
      } else {
        for (const account of visibleAccounts) {
          next.add(account.id);
        }
      }
      return next;
    });
  };

  const toggleSelect = (accountId: string) => {
    if (saving) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!targetGroup || saving) return;
    setSaving(true);
    setError('');
    try {
      await onConfirm({
        accountIds: Array.from(selected),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || !targetGroup) return null;

  return (
    <div className="modal-overlay" style={{ zIndex: 10050 }}>
      <div className="modal group-account-picker-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2 className="group-account-picker-title">
            <FolderPlus size={18} />
            <span>{t('accounts.groups.addAccounts', '添加账号')}</span>
            <span className="group-account-picker-target">{targetGroup.name}</span>
          </h2>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label={t('common.close', '关闭')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body group-account-picker-body">
          <div className="group-account-toolbar">
            <div className="group-account-search">
              <Search size={16} className="group-account-search-icon" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('accounts.search', '搜索账号...')}
              />
            </div>
          </div>

          <div className="group-account-item group-account-item-header">
            <input
              ref={selectAllCheckboxRef}
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAllVisible}
              disabled={saving || visibleAccounts.length === 0}
            />
            <div className="group-account-main">
              <span className="group-account-email" style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-secondary)' }}>
                {t('common.selectAll', '全选')} ({selectedVisibleCount}/{visibleAccounts.length})
              </span>
            </div>
          </div>

          <div className="group-account-list">
            {visibleAccounts.length === 0 ? (
              <div className="group-account-empty">{t('accounts.groups.accountPickerEmpty', '没有符合条件的账号')}</div>
            ) : (
              visibleAccounts.map((account) => {
                const currentGroups = groupsByAccountId.get(account.id) || [];
                const isChecked = selected.has(account.id);
                const isUngrouped = currentGroups.length === 0;

                const email = account.email || account.account_name || account.account_id || '';
                const name = account.name || account.displayName || account.username || '';
                let displayName = email;
                if (email && name && email !== name) {
                  displayName = `${email} (${name})`;
                } else if (!displayName) {
                  displayName = name || account.id || '';
                }

                let planLabel = '';
                let planClass = '';
                if (account.quota) {
                  const badge = getAntigravityTierBadge(account.quota);
                  if (badge.tier !== 'UNKNOWN') {
                    planLabel = badge.label;
                    planClass = badge.className;
                  }
                } else if (account.plan_type) {
                  planLabel = String(account.plan_type).toUpperCase();
                  planClass = 'plan-badge-default';
                } else if (account.subscription_tier) {
                  planLabel = String(account.subscription_tier).toUpperCase();
                  planClass = 'plan-badge-default';
                } else if (account.plan) {
                  planLabel = String(account.plan).toUpperCase();
                  planClass = 'plan-badge-default';
                }

                return (
                  <label
                    key={account.id}
                    className={`group-account-item${isChecked ? ' is-current' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={saving}
                      onChange={() => toggleSelect(account.id)}
                    />
                    <div className="group-account-main">
                      <span className="group-account-email" title={displayName}>
                        {displayName}
                      </span>
                      <div className="group-account-meta">
                        {planLabel && (
                          <span className={`tier-badge ${planClass} group-account-tier-badge`}>
                            {planLabel}
                          </span>
                        )}
                        {isUngrouped ? (
                          <span className="group-account-badge is-ungrouped">
                            {t('accounts.groups.ungrouped', '未分组')}
                          </span>
                        ) : (
                          currentGroups.map((g) => (
                            <span
                              key={g.id}
                              className={`group-account-badge${g.id === targetGroup.id ? ' is-current-target' : ''}`}
                            >
                              {g.name}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          {error && <div className="group-account-error">{error}</div>}
        </div>

        <div className="modal-footer group-account-picker-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel', '取消')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={saving}
          >
            {saving
              ? t('common.saving', '保存中...')
              : `${t('common.save', '保存')} (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 添加到分组弹窗 ──────────────────────────────────────────

interface AddToGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountIds: string[];
  sourceGroupId?: string;
  onAdded: () => Promise<void> | void;
  platform?: string;
}

export const AddToGroupModal = ({ isOpen, onClose, accountIds, sourceGroupId, onAdded, platform }: AddToGroupModalProps) => {
  const { t } = useTranslation();
  useEscClose(isOpen, onClose);
  const platformKey = normalizePlatform(platform || 'antigravity');
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      (async () => setGroups(await getPlatformGroups(platformKey)))();
      setNewName('');
      setError(null);
    }
  }, [isOpen, platformKey]);

  const handleSelect = async (groupId: string) => {
    setError(null);
    try {
      await assignAccountsToPlatformGroup(platformKey, groupId, accountIds);
      if (platformKey === 'antigravity') {
        invalidateLegacyCache();
      }
      await onAdded();
      onClose();
    } catch (err) {
      console.error('Failed to add accounts to group:', err);
      setError(t('accounts.groups.error.addFailed', {
        error: String(err),
      }));
    }
  };

  const handleCreateAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const group = await createPlatformGroup(platformKey, name);
      await assignAccountsToPlatformGroup(platformKey, group.id, accountIds);
      if (platformKey === 'antigravity') {
        invalidateLegacyCache();
      }
      await onAdded();
      onClose();
    } catch (err) {
      console.error('Failed to create group and add accounts:', err);
      setError(t('accounts.groups.error.createAndAddFailed', {
        error: String(err),
      }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal add-to-group-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <FolderPlus size={18} />
            {sourceGroupId ? t('accounts.groups.moveToGroup') : t('accounts.groups.addToGroup')}
          </h2>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="group-create-row">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateAndAdd(); }}
              placeholder={t('accounts.groups.createAndAdd')}
              maxLength={30}
            />
            <button
              className="btn btn-primary"
              onClick={handleCreateAndAdd}
              disabled={!newName.trim()}
            >
              <Plus size={14} />
            </button>
          </div>

          {groups.length > 0 && (
            <div className="add-to-group-list">
              {groups.filter((g) => g.id !== sourceGroupId).map((group) => (
                <div
                  key={group.id}
                  className="add-to-group-item"
                  onClick={() => handleSelect(group.id)}
                >
                  <FolderOpen size={16} className="group-icon" />
                  <span className="group-name">{group.name}</span>
                  <span className="group-count">
                    {group.accountIds.length}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="group-modal-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AccountGroupModal;

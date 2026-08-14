<script setup lang="ts">
/*
 * UserAccess.vue — 系统设置 ·「用户与访问」页签。
 *
 * 编辑的是「哪个账号能到哪些工作区」这一条授权状态,不是个人偏好。它刻意不进 SystemSettings
 * 的草稿与整体保存载荷:一次整对象保存既不该顺手带上授权,也不该悄悄把它抹掉。所以本页签
 * 逐账号保存,每次保存都是一条独立指令,页签本身永远不脏。
 *
 * 两个隐式身份(管理员、本机 `local`)是只读行:它们的「全部工作区」是解析器里的分支而不是
 * 库里的行 —— 正因为不可编辑,管理员才不可能把自己锁在门外。
 *
 * 搜索只改变「看得见什么」,绝不改变「要保存什么」:保存永远提交完整的勾选集合,被过滤
 * 掉的选中项也在其中。否则在搜索框里打一个字就会把没显示出来的授权撤掉。
 */
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import type {
  UserWorkspaceAccessAccount,
  WorkspaceInfo,
  WorkspaceScopeMode,
} from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    /** 已注册工作区(勾选项的来源)。 */
    workspaces?: WorkspaceInfo[]
    /** 账号名册及各自策略;`null` = 尚未取到(与「一个账号都没有」区分开)。 */
    accounts?: UserWorkspaceAccessAccount[] | null
  }>(),
  { workspaces: () => [], accounts: null },
)

const emit = defineEmits<{
  reload: []
  save: [payload: { subject: string; mode: WorkspaceScopeMode; workspaces: string[] }]
}>()

const loaded = computed(() => props.accounts !== null)
const accounts = computed(() => props.accounts ?? [])

// ---- 搜索 ----
const accountQuery = ref('')
const workspaceQuery = ref('')

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase())
}

const visibleAccounts = computed(() =>
  accounts.value.filter((a) => contains(a.subject, accountQuery.value)),
)

const visibleWorkspaces = computed(() =>
  (props.workspaces ?? []).filter((w) => contains(w.name, workspaceQuery.value)),
)

// ---- 编辑态 ----
// 只记「当前在编辑哪一行 + 它的完整草稿」,不镜像整份名册:服务端回推的新名册永远直接可用,
// 无需和本地副本对账。草稿里的 `workspaces` 始终是完整集合,与搜索框无关。
const editingSubject = ref<string | null>(null)
const draftMode = ref<WorkspaceScopeMode>('selected')
const draftWorkspaces = ref<string[]>([])

function startEdit(account: UserWorkspaceAccessAccount): void {
  if (!account.editable) return
  editingSubject.value = account.subject
  // 没有策略的账号从「选中,但一个都没选」开始 —— 这正是它当前的实际效果,而且是一个
  // 管理员看得懂的起点。
  draftMode.value = account.policy?.mode ?? 'selected'
  draftWorkspaces.value = [...(account.policy?.workspaces ?? [])]
}

function cancelEdit(): void {
  editingSubject.value = null
}

function submitEdit(): void {
  if (!editingSubject.value) return
  emit('save', {
    subject: editingSubject.value,
    mode: draftMode.value,
    // `all` 跟随注册表,不携带名字;`selected` 提交完整集合,含被搜索隐藏的那些。
    workspaces: draftMode.value === 'selected' ? [...draftWorkspaces.value] : [],
  })
}

// 名册一变就退出编辑态:此时服务端已确认,继续停留在旧勾选上只会误导。
watch(
  () => props.accounts,
  () => {
    editingSubject.value = null
  },
)

/** 一行策略的只读摘要。 */
function policySummary(account: UserWorkspaceAccessAccount): string {
  if (account.isAdmin) return t('settings.userAccess.policy.implicitAll')
  if (!account.policy) return t('settings.userAccess.policy.none')
  if (account.policy.mode === 'all') return t('settings.userAccess.policy.all')
  return t('settings.userAccess.policy.selected', { count: account.policy.workspaces.length })
}

/** 编辑中的账号里,被搜索隐藏掉的选中项数量 —— 说清楚它们仍会被保存。 */
const hiddenSelectedCount = computed(() => {
  if (draftMode.value !== 'selected') return 0
  const visible = new Set(visibleWorkspaces.value.map((w) => w.name))
  return draftWorkspaces.value.filter((name) => !visible.has(name)).length
})
</script>

<template>
  <div data-testid="settings-user-access">
    <section class="settings-section">
      <p class="settings-section-title">{{ t('settings.userAccess.title.label') }}</p>
      <p class="settings-hint">{{ t('settings.userAccess.hint') }}</p>
      <!-- 新增工作区的默认可见性规则:说在编辑器里,而不是留给管理员事后发现。 -->
      <p class="settings-hint">{{ t('settings.userAccess.newWorkspace.hint') }}</p>

      <div class="user-access-search">
        <input
          v-model="accountQuery"
          class="agent-field"
          :placeholder="t('settings.userAccess.search.account.placeholder')"
          data-testid="settings-user-access-account-search"
        />
        <button class="ghost" data-testid="settings-user-access-reload" @click="emit('reload')">
          {{ t('common.action.refresh.label') }}
        </button>
      </div>
    </section>

    <p v-if="!loaded" class="settings-hint" data-testid="settings-user-access-loading">
      {{ t('settings.userAccess.loading') }}
    </p>
    <p
      v-else-if="visibleAccounts.length === 0"
      class="settings-hint"
      data-testid="settings-user-access-empty"
    >
      {{ t('settings.userAccess.empty') }}
    </p>

    <div
      v-for="account in visibleAccounts"
      :key="account.subject"
      class="user-access-row"
      data-testid="settings-user-access-row"
    >
      <div class="user-access-head">
        <span class="user-access-subject">{{ account.subject }}</span>
        <span
          v-if="account.isAdmin"
          class="user-access-badge"
          data-testid="settings-user-access-admin-badge"
          >{{ t('settings.userAccess.admin.badge.label') }}</span
        >
        <span class="settings-hint">{{ policySummary(account) }}</span>
        <div class="user-access-actions">
          <button
            class="icon-btn"
            :disabled="!account.editable"
            data-testid="settings-user-access-edit"
            @click="startEdit(account)"
          >
            {{ t('common.action.edit.label') }}
          </button>
        </div>
      </div>

      <!-- 不可编辑行:说明为什么,而不是留一个禁用按钮让人猜。 -->
      <p
        v-if="!account.editable"
        class="settings-hint"
        data-testid="settings-user-access-immutable"
      >
        {{ t('settings.userAccess.immutable.hint') }}
      </p>

      <div
        v-if="editingSubject === account.subject"
        class="user-access-edit"
        data-testid="settings-user-access-edit-form"
      >
        <label class="user-access-mode">
          <input
            v-model="draftMode"
            type="radio"
            value="all"
            data-testid="settings-user-access-mode-all"
          />
          <span>{{ t('settings.userAccess.mode.all.label') }}</span>
        </label>
        <label class="user-access-mode">
          <input
            v-model="draftMode"
            type="radio"
            value="selected"
            data-testid="settings-user-access-mode-selected"
          />
          <span>{{ t('settings.userAccess.mode.selected.label') }}</span>
        </label>

        <template v-if="draftMode === 'selected'">
          <input
            v-model="workspaceQuery"
            class="agent-field"
            :placeholder="t('settings.userAccess.search.workspace.placeholder')"
            data-testid="settings-user-access-workspace-search"
          />
          <!-- 搜索只是视图:被隐藏的选中项照样在保存载荷里。 -->
          <p
            v-if="hiddenSelectedCount > 0"
            class="settings-hint"
            data-testid="settings-user-access-hidden-selected"
          >
            {{ t('settings.userAccess.hiddenSelected.hint', { count: hiddenSelectedCount }) }}
          </p>
          <label
            v-for="ws in visibleWorkspaces"
            :key="ws.name"
            class="user-access-pick"
            data-testid="settings-user-access-workspace-pick"
          >
            <input v-model="draftWorkspaces" type="checkbox" :value="ws.name" />
            <span>{{ ws.name }}</span>
          </label>
        </template>

        <div class="user-access-edit-actions">
          <button data-testid="settings-user-access-save" @click="submitEdit">
            {{ t('common.action.save.label') }}
          </button>
          <button class="ghost" data-testid="settings-user-access-cancel" @click="cancelEdit">
            {{ t('common.action.cancel.label') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.user-access-search {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}

.user-access-row {
  border-top: 1px solid var(--c-border);
  padding: var(--sp-3) 0;
}

.user-access-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.user-access-subject {
  font-weight: 600;
}

.user-access-badge {
  color: var(--c-primary);
  font-size: var(--fs-caption, 0.85em);
}

.user-access-actions {
  margin-left: auto;
  display: flex;
  gap: var(--sp-2);
}

.user-access-edit {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
}

.user-access-mode,
.user-access-pick {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.user-access-edit-actions {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}
</style>

<script setup lang="ts">
// The workcenter's "chat robots" page: a global roster on the left, the selected
// robot's configuration and audit trail on the right.
//
// It sits in the workcenter rather than in settings because a robot is neither a
// setting nor scoped to a workspace — it is a standing piece of work with its own
// state, closer to an automation than to a preference. Nothing here holds domain
// state; the roster and every round trip live in the controls layer.
//
// On mobile it degrades to a list → detail drill-down, matching the other
// workcenter pages.
import { computed, ref } from 'vue'
import MobileStack from '@/components/MobileStack/MobileStack.vue'
import { useIsMobile } from '@/composables/useBreakpoint'
import { useTypedI18n } from '@/i18n'
import RobotList from './components/robots/RobotList.vue'
import RobotDetail from './components/robots/RobotDetail.vue'
import RobotForm from './components/robots/RobotForm.vue'
import type {
  AgentConfig,
  ImGroupWorkspaceGrant,
  ImIdentityBinding,
  ImPlatform,
  ImRobot,
  ImRobotTurnLog,
  RobotConfigInput,
  ToolManifestEntry,
  WorkspaceInfo,
} from '@ccc/shared/protocol'

const props = defineProps<{
  robots: ImRobot[]
  turns: ImRobotTurnLog[]
  selectedId: string | null
  agents: AgentConfig[]
  isAdmin: boolean
  /** Tool manifest per vendor for the robot form (no workspace scope). */
  toolManifest: Record<string, ToolManifestEntry[] | null>
  toolManifestLoading: boolean
  toolManifestError: string | null
  workspaces: WorkspaceInfo[]
  imIdentityBindings: ImIdentityBinding[]
  imGroupWorkspaceScopes: ImGroupWorkspaceGrant[]
}>()

const emit = defineEmits<{
  (e: 'select', robotId: string | null): void
  (e: 'create', name: string, platform: ImPlatform, config: RobotConfigInput): void
  (e: 'update', robotId: string, config: RobotConfigInput): void
  (e: 'delete', robotId: string): void
  (e: 'enable', robotId: string): void
  (e: 'disable', robotId: string): void
  (e: 'load-tool-manifest', vendor: string): void
  (e: 'admin-revoke-im-identity', bindingId: string): void
  (
    e: 'load-im-group-scopes',
    platform: ImPlatform,
    providerAccountKey: string,
    chatId: string,
  ): void
  (
    e: 'save-im-group-scopes',
    platform: ImPlatform,
    providerAccountKey: string,
    chatId: string,
    workspaceNames: string[],
  ): void
}>()

const { t } = useTypedI18n()
const isMobile = useIsMobile()
const formOpen = ref(false)
/** The robot the form is editing; null while creating. */
const editing = ref<ImRobot | null>(null)
const mobilePane = ref<'list' | 'detail'>('list')

const selected = computed(() => props.robots.find((r) => r.id === props.selectedId) ?? null)

const mobilePanes = computed(() => [
  { key: 'list', title: t('robot.list.title') },
  { key: 'detail', title: selected.value?.name ?? t('robot.list.title') },
])

function select(robotId: string): void {
  emit('select', robotId)
  mobilePane.value = 'detail'
}

function openCreate(): void {
  editing.value = null
  formOpen.value = true
}

function openEdit(robotId: string): void {
  editing.value = props.robots.find((r) => r.id === robotId) ?? null
  formOpen.value = true
}

function submitCreate(name: string, platform: ImPlatform, config: RobotConfigInput): void {
  formOpen.value = false
  emit('create', name, platform, config)
}

function submitUpdate(robotId: string, config: RobotConfigInput): void {
  formOpen.value = false
  emit('update', robotId, config)
}

function onLoadGroupScopes(chatId: string): void {
  const r = selected.value
  if (!r) return
  emit('load-im-group-scopes', r.platform, r.appId, chatId)
}

function onSaveGroupScopes(chatId: string, workspaceNames: string[]): void {
  const r = selected.value
  if (!r) return
  emit('save-im-group-scopes', r.platform, r.appId, chatId, workspaceNames)
}
</script>

<template>
  <MobileStack
    v-if="isMobile"
    :panes="mobilePanes"
    :active-key="mobilePane"
    :active-token="selectedId ?? 'list'"
    :back-label="t('robot.list.title')"
    @back="mobilePane = 'list'"
  >
    <template #list>
      <RobotList
        :robots="robots"
        :selected-id="selectedId"
        :is-admin="isAdmin"
        @select="select"
        @create="openCreate"
      />
    </template>
    <template #detail>
      <RobotDetail
        :robot="selected"
        :turns="turns"
        :is-admin="isAdmin"
        :workspaces="workspaces"
        :im-identity-bindings="imIdentityBindings"
        :im-group-workspace-scopes="imGroupWorkspaceScopes"
        @edit="openEdit"
        @delete="emit('delete', $event)"
        @enable="emit('enable', $event)"
        @disable="emit('disable', $event)"
        @admin-revoke-im-identity="emit('admin-revoke-im-identity', $event)"
        @load-im-group-scopes="onLoadGroupScopes"
        @save-im-group-scopes="onSaveGroupScopes"
      />
    </template>
  </MobileStack>

  <div v-else class="rc">
    <aside class="rc-side">
      <RobotList
        :robots="robots"
        :selected-id="selectedId"
        :is-admin="isAdmin"
        @select="select"
        @create="openCreate"
      />
    </aside>
    <section class="rc-main">
      <RobotDetail
        :robot="selected"
        :turns="turns"
        :is-admin="isAdmin"
        :workspaces="workspaces"
        :im-identity-bindings="imIdentityBindings"
        :im-group-workspace-scopes="imGroupWorkspaceScopes"
        @edit="openEdit"
        @delete="emit('delete', $event)"
        @enable="emit('enable', $event)"
        @disable="emit('disable', $event)"
        @admin-revoke-im-identity="emit('admin-revoke-im-identity', $event)"
        @load-im-group-scopes="onLoadGroupScopes"
        @save-im-group-scopes="onSaveGroupScopes"
      />
    </section>
  </div>

  <RobotForm
    :open="formOpen"
    :robot="editing"
    :agents="agents"
    :tool-manifest="toolManifest"
    :tool-manifest-loading="toolManifestLoading"
    :tool-manifest-error="toolManifestError"
    @create="submitCreate"
    @update="submitUpdate"
    @cancel="formOpen = false"
    @load-tool-manifest="emit('load-tool-manifest', $event)"
  />
</template>

<style scoped>
.rc {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.rc-side {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--c-border);
  padding: 12px;
  overflow-y: auto;
}
.rc-main {
  flex: 1;
  min-width: 0;
  padding: 16px;
  overflow-y: auto;
  display: flex;
}
</style>

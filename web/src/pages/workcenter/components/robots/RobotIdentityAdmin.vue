<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type {
  ImGroupWorkspaceGrant,
  ImIdentityBinding,
  ImRobot,
  WorkspaceInfo,
} from '@ccc/shared/protocol'

const { t, d } = useTypedI18n()

const props = defineProps<{
  robot: ImRobot
  bindings: ImIdentityBinding[]
  groupGrants: ImGroupWorkspaceGrant[]
  workspaces: WorkspaceInfo[]
}>()

const emit = defineEmits<{
  loadGroupScopes: [chatId: string]
  saveGroupScopes: [chatId: string, workspaceNames: string[]]
  revokeBinding: [bindingId: string]
}>()

const chatId = ref('')
const selectedWorkspaces = ref<string[]>([])
const revokeTarget = ref<ImIdentityBinding | null>(null)

const chatSuggestions = computed(() => props.robot.chatAllowlist)

watch(
  () => props.groupGrants,
  (grants) => {
    selectedWorkspaces.value = grants.map((g) => g.workspaceName)
  },
  { immediate: true },
)

function formatTime(ms: number): string {
  return d(new Date(ms), 'full')
}

function loadScopes(): void {
  const id = chatId.value.trim()
  if (!id) return
  emit('loadGroupScopes', id)
}

function saveScopes(): void {
  const id = chatId.value.trim()
  if (!id) return
  emit('saveGroupScopes', id, [...selectedWorkspaces.value])
}

function toggleWorkspace(name: string, checked: boolean): void {
  if (checked) {
    if (!selectedWorkspaces.value.includes(name)) {
      selectedWorkspaces.value = [...selectedWorkspaces.value, name]
    }
  } else {
    selectedWorkspaces.value = selectedWorkspaces.value.filter((w) => w !== name)
  }
}

function confirmRevoke(): void {
  if (revokeTarget.value) emit('revokeBinding', revokeTarget.value.id)
  revokeTarget.value = null
}
</script>

<template>
  <section class="ria" data-testid="robot-identity-admin">
    <h3 class="ria-title">{{ t('robot.identityAdmin.title') }}</h3>
    <p class="rb-hint">{{ t('robot.identityAdmin.hint') }}</p>

    <p v-if="bindings.length === 0" class="rb-hint">{{ t('robot.identityAdmin.empty') }}</p>
    <table v-else class="ria-table">
      <thead>
        <tr>
          <th>{{ t('robot.identityAdmin.sender.label') }}</th>
          <th>{{ t('robot.identityAdmin.subject.label') }}</th>
          <th>{{ t('robot.identityAdmin.verified.label') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in bindings" :key="b.id">
          <td class="ria-mono">{{ b.senderId }}</td>
          <td>{{ b.subject }}</td>
          <td>{{ formatTime(b.verifiedAt) }}</td>
          <td>
            <button type="button" class="ghost danger" @click="revokeTarget = b">
              {{ t('robot.identityAdmin.revoke.label') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <h3 class="ria-title">{{ t('robot.identityAdmin.groupScope.title') }}</h3>
    <p class="rb-hint">{{ t('robot.identityAdmin.groupScope.hint') }}</p>
    <div class="ria-scope-form">
      <label class="rb-hint">{{ t('robot.identityAdmin.groupScope.chatId.label') }}</label>
      <input
        v-model="chatId"
        list="ria-chat-ids"
        :placeholder="t('robot.identityAdmin.groupScope.chatId.placeholder')"
        data-testid="robot-group-chat-id"
      />
      <datalist id="ria-chat-ids">
        <option v-for="id in chatSuggestions" :key="id" :value="id" />
      </datalist>
      <button type="button" class="ghost" data-testid="robot-group-scope-load" @click="loadScopes">
        {{ t('robot.identityAdmin.groupScope.load.label') }}
      </button>
    </div>

    <div v-if="chatId.trim()" class="ria-workspaces">
      <p v-if="workspaces.length === 0" class="rb-hint">
        {{ t('robot.identityAdmin.groupScope.empty') }}
      </p>
      <label v-for="ws in workspaces" :key="ws.name" class="ria-ws-row">
        <input
          type="checkbox"
          :checked="selectedWorkspaces.includes(ws.name)"
          @change="toggleWorkspace(ws.name, ($event.target as HTMLInputElement).checked)"
        />
        {{ ws.name }}
      </label>
      <button
        type="button"
        class="primary"
        data-testid="robot-group-scope-save"
        @click="saveScopes"
      >
        {{ t('robot.identityAdmin.groupScope.save.label') }}
      </button>
    </div>

    <ConfirmDialog
      :open="revokeTarget !== null"
      danger
      :title="t('robot.identityAdmin.revoke.confirm.title')"
      :message="t('robot.identityAdmin.revoke.confirm.body')"
      :confirm-label="t('robot.identityAdmin.revoke.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmRevoke"
      @cancel="revokeTarget = null"
    />
  </section>
</template>

<style scoped>
.ria {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--c-border);
}
.ria-title {
  margin: 0 0 8px;
  font-size: 1rem;
}
.ria-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
  font-size: 0.875rem;
}
.ria-table th,
.ria-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--c-border);
}
.ria-mono {
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
}
.ria-scope-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
.ria-scope-form input {
  min-width: 200px;
}
.ria-workspaces {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
}
.ria-ws-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.875rem;
}
</style>

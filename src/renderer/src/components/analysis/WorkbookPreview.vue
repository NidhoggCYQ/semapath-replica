<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AnalysisPreview } from '@shared/analysis'
defineProps<{ preview: AnalysisPreview; loading: boolean }>()
const emit = defineEmits<{ page: [page: number] }>()
const { t } = useI18n()
</script>
<template>
  <section :aria-label="t('analysis.preview')" :aria-busy="loading">
    <div class="analysis-section-heading">
      <h3>{{ t('analysis.preview') }}</h3>
      <span class="analysis-muted">{{ t('analysis.rowCount', { count: preview.totalRows }) }}</span>
    </div>
    <p class="analysis-muted">{{ t('analysis.previewNotice') }}</p>
    <div class="analysis-table-wrap preview-table">
      <table data-testid="analysis-preview-table">
        <thead>
          <tr>
            <th>{{ t('analysis.row') }}</th>
            <th v-for="column in preview.columns" :key="column.key">
              <span class="analysis-muted">{{ column.key }}</span> {{ column.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in preview.rows" :key="row.rowNumber">
            <th scope="row">{{ row.rowNumber }}</th>
            <td
              v-for="cell in row.cells"
              :key="cell.address"
              :title="cell.formula ? `=${cell.formula}` : cell.address"
              :class="{ 'cell-error': cell.error }"
            >
              {{ cell.display }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <button
        type="button"
        class="analysis-button"
        :disabled="loading || preview.page <= 1"
        @click="emit('page', preview.page - 1)"
      >
        {{ t('analysis.previous') }}</button
      ><span>{{ t('analysis.pages', { page: preview.page, count: preview.pageCount }) }}</span
      ><button
        type="button"
        class="analysis-button"
        :disabled="loading || preview.page >= preview.pageCount"
        @click="emit('page', preview.page + 1)"
      >
        {{ t('analysis.next') }}
      </button>
    </div>
  </section>
</template>
<style scoped>
.preview-table {
  max-height: 480px;
}
.preview-table td {
  max-width: 360px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cell-error {
  color: var(--destructive);
}
</style>

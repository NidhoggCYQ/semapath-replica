import { Node, mergeAttributes } from '@tiptap/core'

export const AnalysisContextNode = Node.create({
  name: 'analysisContext',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      contextId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-analysis-context')
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label') ?? element.textContent ?? ''
      },
      kind: { default: 'data', parseHTML: (element) => element.getAttribute('data-kind') ?? 'data' }
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-analysis-context]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-analysis-context': node.attrs.contextId,
        'data-kind': node.attrs.kind,
        'data-label': node.attrs.label,
        class: 'analysis-context-node',
        contenteditable: 'false',
        title: node.attrs.label
      }),
      node.attrs.kind === 'quote' ? `“${node.attrs.label}”` : `@${node.attrs.label}`
    ]
  },
  renderText() {
    return ''
  }
})

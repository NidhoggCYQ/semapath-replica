// Synthetic native protocol only. This is not an Analysis Services engine or a PBIX fixture.
const readline = require('node:readline')
const crypto = require('node:crypto')
const model = {
  id: 'synthetic-native-model',
  port: 49711,
  databaseId: 'synthetic-orders-model',
  name: '合成本地订单模型',
  processId: process.pid,
  startedAt: new Date().toISOString()
}
const column = (name, type) => ({ name, type, hidden: false, formatString: '', expression: '' })
const schema = {
  fetchedAt: new Date().toISOString(),
  source: 'local_tom',
  coverage: {
    tables: 'available',
    columns: 'available',
    measures: 'available',
    relationships: 'available'
  },
  tables: [
    {
      name: 'Orders',
      hidden: false,
      description: '',
      columns: [column('Customer', 'String'), column('Amount', 'Decimal')],
      measures: [
        {
          name: 'Total Amount',
          expression: "SUM('Orders'[Amount])",
          formatString: '#,0.00',
          description: '合成金额度量值',
          hidden: false
        }
      ]
    },
    {
      name: 'Customers',
      hidden: false,
      description: '',
      columns: [column('Customer', 'String'), column('Region', 'String')],
      measures: []
    }
  ],
  relationships: [
    {
      name: 'Orders_Customers',
      fromTable: 'Orders',
      fromColumn: 'Customer',
      toTable: 'Customers',
      toColumn: 'Customer',
      active: true,
      crossFilter: 'OneDirection'
    }
  ],
  issues: []
}
const data = {
  columns: [
    { name: '[Customer]', type: 'String' },
    { name: '[Amount]', type: 'Decimal' }
  ],
  rows: [
    ['001', '0.10000000000000000000'],
    ['001', '0.20000000000000000000']
  ],
  complete: true
}
const reply = (id, result, error) =>
  process.stdout.write(
    JSON.stringify(error ? { id, ok: false, error } : { id, ok: true, result }) + '\n'
  )
const pending = new Map()
readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    const request = JSON.parse(line)
    if (request.method === 'cancel') {
      const timer = pending.get(request.requestId)
      if (timer) {
        clearTimeout(timer)
        pending.delete(request.requestId)
        reply(request.requestId, null, 'PBI_CANCELLED')
      }
      reply(request.id, { requested: !!timer })
      return
    }
    if (request.method === 'local.discover')
      return reply(request.id, [
        model,
        {
          ...model,
          id: 'synthetic-second-model',
          databaseId: 'synthetic-second',
          name: '第二个合成模型'
        }
      ])
    if (request.method === 'local.connect') return reply(request.id, [model])
    if (request.method.endsWith('.schema')) return reply(request.id, schema)
    if (request.method.endsWith('.query')) {
      if (request.dax.includes('DELETED')) return reply(request.id, null, 'PBI_MODEL_CHANGED')
      const result = {
        data,
        schema,
        schemaSha256: crypto
          .createHash('sha256')
          .update(JSON.stringify({ tables: schema.tables, relationships: schema.relationships }))
          .digest('hex')
      }
      if (request.dax.includes('SLOW')) {
        pending.set(
          request.id,
          setTimeout(() => {
            pending.delete(request.id)
            reply(request.id, result)
          }, 60000)
        )
        return
      }
      return reply(request.id, result)
    }
    reply(request.id, null, 'PBI_PROTOCOL')
  })
  .on('close', () => {
    for (const timer of pending.values()) clearTimeout(timer)
  })

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
vi.unmock('node:fs')
vi.unmock('fs')
const storage = vi.hoisted(() => ({ values: new Map<string, string>(), available: true }))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => 'test-encrypted',
    encryptString: (text: string) => {
      const id = randomUUID()
      storage.values.set(id, text)
      return Buffer.from(id)
    },
    decryptString: (bytes: Buffer) => {
      const value = storage.values.get(bytes.toString())
      if (!value) throw new Error('Unavailable')
      return value
    }
  }
}))
import { parseDaxResult } from '@/analysis/powerbi/rest'
import { readOnlyDax } from '@/analysis/powerbi/dax'
import { PbiAuth, pbiAccountKey } from '@/analysis/powerbi/auth'
import { PbiCloud } from '@/analysis/powerbi/cloud'
import { PbiService } from '@/analysis/powerbi/service'
import { AnalysisError } from '@/analysis/errors'
import { SourceOriginSchema, type SourceOrigin } from '@shared/analysisData'
import type { PbiApplication } from '@shared/analysisPowerBi'

let directory: string
const app: PbiApplication = {
  clientId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  environment: 'global'
}
const model = {
  accountId: 'synthetic-account',
  workspaceId: null,
  datasetId: '33333333-3333-4333-8333-333333333333',
  name: 'Synthetic'
}
beforeEach(async () => {
  storage.available = true
  storage.values.clear()
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-powerbi-'))
})
afterEach(async () => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()))
    throw new Error('Unsafe cleanup')
  await rm(directory, { recursive: true, force: true })
})
const result = (rows: string) => '{"results":[{"tables":[{"rows":' + rows + '}]}]}'
describe('Power BI result precision and complete-result boundary', () => {
  it('preserves integer/decimal literals and distinguishes null, missing, empty and zero', () => {
    const data = parseDaxResult(
      result(
        '[{"[id]":9007199254740993123,"[amount]":0.12345678901234567890,"[empty]":"","[null]":null},{"[id]":0,"[amount]":1e-20,"[flag]":false}]'
      )
    )
    expect(data.rows).toEqual([
      ['9007199254740993123', '0.12345678901234567890', '', null, null],
      ['0', '1e-20', null, null, 'FALSE']
    ])
    expect(parseDaxResult(result('[]'))).toEqual({ columns: [], rows: [], complete: true })
  })
  it.each([
    '{"error":{"code":"QueryError"}}',
    '{"results":[{"error":{"code":"MoreRowsThanAllowed"},"tables":[{"rows":[]}]}]}',
    '{"results":[{"tables":[{"rows":[],"error":{"code":"Truncated"}}]}]}',
    '{"results":[{"tables":[{"rows":[]} ,{"rows":[]}]}]}'
  ])('rejects HTTP-200 errors or multiple tables: %s', (body) => {
    expect(() => parseDaxResult(body)).toThrow('PBI_QUERY_FAILED')
  })
  it('rejects row/column and structured-value overflow instead of silently truncating', () => {
    expect(() =>
      parseDaxResult(result(JSON.stringify(Array.from({ length: 5001 }, () => ({ '[x]': 1 })))))
    ).toThrow('PBI_LIMIT')
    const wide = Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['c' + i, 1]))
    expect(() => parseDaxResult(result(JSON.stringify([wide])))).toThrow('PBI_LIMIT')
    expect(() => parseDaxResult(result('[{"[x]":{"n":1}}]'))).toThrow('PBI_PROTOCOL')
  })
  it('allows query-local definitions and quoted names while excluding writes, comments and multiple statements', () => {
    expect(
      readOnlyDax(
        "DEFINE MEASURE 'Orders'[Total] = SUM('Orders'[Amount]) EVALUATE ROW(\"Total\", [Total])"
      )
    ).toContain('DEFINE')
    expect(readOnlyDax("EVALUATE 'UPDATE'")).toBe("EVALUATE 'UPDATE'")
    for (const query of [
      'ALTER MODEL',
      'EVALUATE ROW("v",1); EVALUATE ROW("v",2)',
      'EVALUATE ROW("v",1) -- comment',
      "EVALUATE 'broken"
    ])
      expect(() => readOnlyDax(query)).toThrow('PBI_DAX_READ_ONLY')
  })
})
function authentication(tenant = app.tenantId) {
  let authorization: Record<string, string> = {},
    cache = 'synthetic-msal-token-cache'
  const account = {
    homeAccountId: 'synthetic-home',
    tenantId: tenant,
    username: 'synthetic@example.invalid',
    name: 'Synthetic'
  }
  const redeem = vi.fn(async (input: { codeVerifier: string }) => {
    expect(createHash('sha256').update(input.codeVerifier).digest('base64url')).toBe(
      authorization.codeChallenge
    )
    return {
      account,
      accessToken: 'synthetic-access-token',
      expiresOn: new Date(Date.now() + 3600000)
    }
  })
  const client = {
    getTokenCache: () => ({
      getAllAccounts: async () => [account],
      serialize: () => cache,
      deserialize: (value: string) => {
        cache = value
      }
    }),
    getAuthCodeUrl: vi.fn(async (input: Record<string, string>) => {
      authorization = input
      return (
        'https://login.microsoftonline.com/' +
        app.tenantId +
        '/oauth2/v2.0/authorize?state=' +
        input.state
      )
    }),
    acquireTokenByCode: redeem,
    acquireTokenSilent: vi.fn(async () => ({
      account,
      accessToken: 'synthetic-access-token',
      expiresOn: new Date(Date.now() + 3600000)
    }))
  }
  const auth = new PbiAuth(path.join(directory, 'auth.bin'), (() => client) as never, async () => {
    const target = new URL(authorization.redirectUri)
    target.hostname = '127.0.0.1'
    expect((await fetch(target + '?state=incorrect&code=ignored')).status).toBe(400)
    expect(redeem).not.toHaveBeenCalled()
    expect(
      (await fetch(target + '?state=' + authorization.state + '&code=synthetic-code')).status
    ).toBe(200)
  })
  return { auth, client, redeem }
}
describe('Public-client OAuth and account lifecycle', () => {
  it('uses loopback state/PKCE, seals token cache and restores a public account without exposing tokens', async () => {
    const { auth, client } = authentication()
    await auth.configure(app)
    const status = await auth.login(new AbortController().signal)
    expect(status.account?.id).toBe(pbiAccountKey(app, 'synthetic-home'))
    expect(JSON.stringify(status)).not.toContain('synthetic-access-token')
    const bytes = await readFile(path.join(directory, 'auth.bin'))
    expect(bytes.toString()).not.toContain('synthetic-msal-token-cache')
    const restored = new PbiAuth(path.join(directory, 'auth.bin'), (() => client) as never)
    expect((await restored.status()).account?.id).toBe(status.account?.id)
    expect(
      (await restored.token(status.account!.id, new AbortController().signal)).accessToken
    ).toBe('synthetic-access-token')
    await restored.logout()
    expect((await restored.status()).account).toBeNull()
    await expect(restored.token(status.account!.id, new AbortController().signal)).rejects.toThrow(
      'PBI_ACCOUNT_CHANGED'
    )
  })
  it('rejects a mismatched tenant and can retry after a cancelled sign-in', async () => {
    const wrong = authentication('44444444-4444-4444-8444-444444444444')
    await wrong.auth.configure(app)
    await expect(wrong.auth.login(new AbortController().signal)).rejects.toThrow('PBI_AUTH_FAILED')
    const { auth } = authentication()
    await auth.configure(app)
    const controller = new AbortController()
    controller.abort(new AnalysisError('PBI_CANCELLED'))
    await expect(auth.login(controller.signal)).rejects.toThrow('PBI_CANCELLED')
    expect((await auth.login(new AbortController().signal)).account).not.toBeNull()
  })
  it('has no plaintext storage fallback when native encryption is unavailable', async () => {
    storage.available = false
    const { auth } = authentication()
    expect(() => auth.configure(app)).toThrow('PBI_SECRET_UNAVAILABLE')
    await expect(readFile(path.join(directory, 'auth.bin'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
describe('Cloud REST, task ownership and immutable Power BI snapshots', () => {
  it('leases cloud metadata and query results for natural analysis without recursively saving a task', async () => {
    const schema = {
      fetchedAt: new Date().toISOString(),
      source: 'cloud_xmla',
      coverage: {
        tables: 'available',
        columns: 'available',
        measures: 'available',
        relationships: 'available'
      },
      tables: [],
      relationships: [],
      issues: []
    }
    const analysis = { get: () => ({}), addSnapshot: vi.fn() },
      auth = {
        epoch: 0,
        onChange: undefined as (() => void) | undefined,
        assertCurrent: vi.fn(),
        application: () => app
      }
    let finish: ((value: unknown) => void) | undefined
    const answer = { model, data: parseDaxResult(result('[{"[Amount]":0.10000000000000000000}]')) }
    const cloud = { schema: vi.fn(async () => schema), query: vi.fn(async () => answer) }
    const service = new PbiService(
      analysis as never,
      path.join(directory, 'natural-bindings.json'),
      auth as never,
      { dispose: vi.fn() } as never,
      cloud as never
    )
    const taskId = randomUUID(),
      binding = service.bind(taskId, { kind: 'cloud', model })
    const payload = await service.withNatural(
      taskId,
      binding.id,
      'rest',
      randomUUID(),
      7,
      new AbortController().signal,
      async (session) => {
        expect(await session.schema()).toEqual(schema)
        expect(() => service.bind(taskId, { kind: 'cloud', model })).toThrow('BUSY')
        const data = await session.query("EVALUATE 'Orders'", '自动取数')
        expect(data.origin.result?.rows).toEqual([['1', '0.10000000000000000000']])
        session.seal()
        return data
      }
    )
    expect(payload.origin.powerBi?.accountId).toBe(model.accountId)
    expect(analysis.addSnapshot).not.toHaveBeenCalled()
    cloud.query = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    ) as never
    const pending = service.withNatural(
      taskId,
      binding.id,
      'rest',
      randomUUID(),
      7,
      new AbortController().signal,
      (session) => session.query("EVALUATE 'Orders'", '已退出账号')
    )
    const assertion = expect(pending).rejects.toThrow('PBI_ACCOUNT_CHANGED')
    auth.epoch++
    auth.onChange!()
    finish!(answer)
    await assertion
    expect(service.status(taskId)).toBeNull()
    expect(analysis.addSnapshot).not.toHaveBeenCalled()
  })
  it('uses fixed China endpoints, rejects redirects and surfaces tenant/permission/HTTP-200 errors', async () => {
    const auth = {
      epoch: 0,
      application: () => ({ ...app, environment: 'china' }),
      assertCurrent: vi.fn(),
      token: async () => ({
        accessToken: 'synthetic',
        expiresOn: new Date(Date.now() + 3600000).toISOString()
      })
    }
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      expect(options.redirect).toBe('error')
      expect(url).toMatch(/^https:\/\/api.powerbi.cn\/v1.0\/myorg\//)
      return new Response(
        url.endsWith('/datasets')
          ? JSON.stringify({ value: [{ id: model.datasetId, name: model.name }] })
          : result('[{"[Amount]":0.10000000000000000000}]')
      )
    })
    const cloud = new PbiCloud(auth as never, {} as never, fetcher as never)
    const data = await cloud.query(
      model,
      'EVALUATE ROW("Amount",0.1)',
      'rest',
      new AbortController().signal
    )
    // resolve first checks the selected dataset by its exact ID.
    expect(data.data.rows).toEqual([['0.10000000000000000000']])
    for (const [status, code] of [
      [401, 'PBI_AUTH_REQUIRED'],
      [403, 'PBI_PERMISSION'],
      [429, 'PBI_THROTTLED']
    ] as const) {
      fetcher.mockImplementationOnce(async () => new Response('', { status }))
      await expect(
        cloud.models(model.accountId, null, new AbortController().signal)
      ).rejects.toThrow(code)
    }
  })
  it('persists a typed source with exact row text and provenance; cloud cancellation discards late results', async () => {
    let captured: SourceOrigin | undefined,
      bytes: Buffer | undefined,
      finish: ((value: unknown) => void) | undefined
    const analysis = {
      get: () => ({}),
      addSnapshot: vi.fn(async (_id: string, data: Buffer, origin: SourceOrigin) => {
        captured = SourceOriginSchema.parse(origin)
        bytes = data
        return { id: task }
      })
    }
    const auth = { epoch: 0, onChange: undefined, assertCurrent: vi.fn(), application: () => app }
    const answer = {
      data: parseDaxResult(
        result('[{"[Amount]":0.10000000000000000000},{"[Amount]":0.20000000000000000000}]')
      ),
      model
    }
    const cloud = { query: vi.fn(async () => answer) }
    const service = new PbiService(
      analysis as never,
      path.join(directory, 'bindings.json'),
      auth as never,
      { dispose: vi.fn() } as never,
      cloud as never
    )
    const task = randomUUID(),
      binding = service.bind(task, { kind: 'cloud', model }),
      query = {
        requestId: randomUUID(),
        bindingId: binding.id,
        title: 'PBI精确快照',
        dax: "EVALUATE 'Orders'",
        transport: 'rest' as const
      }
    await service.query(task, query, 7)
    expect(captured?.powerBi?.querySha256).toBe(
      createHash('sha256').update(query.dax).digest('hex')
    )
    expect(captured?.result?.rows[0]).toEqual(['1', '0.10000000000000000000'])
    expect(
      XLSX.utils.sheet_to_json(XLSX.read(bytes!, { type: 'buffer' }).Sheets['数据'], { header: 1 })
    ).toHaveLength(3)
    expect(
      new PbiService(
        analysis as never,
        path.join(directory, 'bindings.json'),
        auth as never,
        {} as never,
        cloud as never
      ).binding(task)?.id
    ).toBe(binding.id)
    cloud.query = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    ) as never
    const pending = service.query(task, { ...query, requestId: randomUUID() }, 7)
    expect(service.cancel(task, service.status(task)!.requestId, 99)).toBe(false)
    expect(service.cancel(task, service.status(task)!.requestId, 7)).toBe(true)
    finish!(answer)
    await expect(pending).rejects.toThrow('PBI_CLOUD_CANCELLED')
    expect(analysis.addSnapshot).toHaveBeenCalledTimes(1)
  })
})

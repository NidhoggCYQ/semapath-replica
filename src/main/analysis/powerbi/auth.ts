import { PublicClientApplication, type AuthenticationResult } from '@azure/msal-node'
import { safeStorage, shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  PbiApplicationSchema,
  type PbiApplication,
  type PbiAuthStatus
} from '@shared/analysisPowerBi'
import { AnalysisError } from '../errors'
import { PBI_CLOUDS, pbiScopes } from './clouds'

const StateSchema = z.object({
  application: PbiApplicationSchema.nullable(),
  active: z.string().nullable(),
  cache: z.string().max(4 * 1024 * 1024)
})
type State = z.infer<typeof StateSchema>
export function pbiAccountKey(application: PbiApplication, homeId: string) {
  return createHash('sha256')
    .update(
      JSON.stringify([application.environment, application.tenantId, application.clientId, homeId])
    )
    .digest('hex')
}
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new AnalysisError('PBI_CANCELLED'))
  return new Promise((resolve, reject) => {
    const stop = () => {
      cleanup()
      reject(signal.reason ?? new AnalysisError('PBI_CANCELLED'))
    }
    const cleanup = () => signal.removeEventListener('abort', stop)
    signal.addEventListener('abort', stop, { once: true })
    pending.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}
export class PbiAuth {
  private state: State | undefined
  private client: PublicClientApplication | undefined
  private interactive = false
  epoch = 0
  onChange: (() => void) | undefined
  constructor(
    private readonly file: string,
    private readonly createClient = (
      config: ConstructorParameters<typeof PublicClientApplication>[0]
    ) => new PublicClientApplication(config),
    private readonly openBrowser = (url: string) => shell.openExternal(url)
  ) {}
  private available() {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new AnalysisError('PBI_SECRET_UNAVAILABLE')
  }
  private load(): State {
    if (this.state) return this.state
    try {
      const data = readFileSync(this.file)
      if (data.length > 8 * 1024 * 1024) throw new AnalysisError('PBI_SECRET_UNAVAILABLE')
      this.available()
      this.state = StateSchema.parse(JSON.parse(safeStorage.decryptString(data)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        this.state = { application: null, active: null, cache: '' }
      else throw new AnalysisError('PBI_SECRET_UNAVAILABLE')
    }
    return this.state!
  }
  private persist() {
    this.available()
    if (!StateSchema.safeParse(this.load()).success) throw new AnalysisError('PBI_LIMIT')
    mkdirSync(path.dirname(this.file), { recursive: true })
    const bytes = safeStorage.encryptString(JSON.stringify(this.load()))
    writeFileSync(this.file + '.tmp', bytes, { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
  private change() {
    this.epoch++
    this.onChange?.()
  }
  private getClient(): PublicClientApplication {
    const state = this.load(),
      app = state.application
    if (!app) throw new AnalysisError('PBI_NOT_CONFIGURED')
    this.available()
    if (this.client) return this.client
    const client = this.createClient({
      auth: {
        clientId: app.clientId,
        authority: PBI_CLOUDS[app.environment].authority + '/' + app.tenantId
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async () => {},
          afterCacheAccess: async (context) => {
            if (context.cacheHasChanged && this.client === client && this.state === state) {
              state.cache = context.tokenCache.serialize()
              this.persist()
            }
          }
        }
      },
      system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } }
    })
    if (state.cache)
      try {
        client.getTokenCache().deserialize(state.cache)
      } catch {
        throw new AnalysisError('PBI_SECRET_UNAVAILABLE')
      }
    this.client = client
    return client
  }
  application() {
    const app = this.load().application
    if (!app) throw new AnalysisError('PBI_NOT_CONFIGURED')
    return app
  }
  currentId() {
    const state = this.load()
    return state.application && state.active ? pbiAccountKey(state.application, state.active) : null
  }
  assertCurrent(id: string, epoch = this.epoch) {
    if (this.epoch !== epoch || this.currentId() !== id)
      throw new AnalysisError('PBI_ACCOUNT_CHANGED')
  }
  async status(): Promise<PbiAuthStatus> {
    const state = this.load()
    if (!state.application || !state.active)
      return { application: state.application, account: null }
    const epoch = this.epoch,
      accounts = await this.getClient().getTokenCache().getAllAccounts()
    if (epoch !== this.epoch) throw new AnalysisError('PBI_ACCOUNT_CHANGED')
    const account = accounts.find(
      (a) =>
        a.homeAccountId === state.active && a.tenantId.toLowerCase() === state.application!.tenantId
    )
    return {
      application: state.application,
      account: account
        ? {
            id: this.currentId()!,
            tenantId: account.tenantId,
            username: account.username,
            name: account.name ?? account.username
          }
        : null
    }
  }
  configure(input: PbiApplication) {
    if (this.interactive) throw new AnalysisError('BUSY')
    this.change()
    this.client = undefined
    this.state = { application: PbiApplicationSchema.parse(input), active: null, cache: '' }
    this.persist()
    return this.status()
  }
  logout() {
    if (this.interactive) throw new AnalysisError('BUSY')
    this.change()
    this.client = undefined
    try {
      const state = this.load()
      this.state = { application: state.application, active: null, cache: '' }
      this.persist()
    } catch {
      this.state = { application: null, active: null, cache: '' }
      try {
        unlinkSync(this.file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new AnalysisError('STORAGE_ERROR')
      }
    }
    return this.status()
  }
  async login(signal: AbortSignal): Promise<PbiAuthStatus> {
    if (this.interactive) throw new AnalysisError('BUSY')
    const application = this.application(),
      state = this.load()
    const client = this.getClient(),
      scopes = pbiScopes(application)
    this.change()
    const epoch = this.epoch
    this.interactive = true
    const verifier = randomBytes(48).toString('base64url'),
      challenge = createHash('sha256').update(verifier).digest('base64url'),
      csrf = randomBytes(32).toString('base64url')
    let redirect = '',
      resolveCode: (code: string) => void = () => {},
      rejectCode: (error: unknown) => void = () => {}
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })
    // Attach rejection handling before a callback or cancellation can race the URL request.
    void code.catch(() => {})
    const server = createServer({ maxHeaderSize: 32768 }, (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      if (request.method !== 'GET' || url.pathname !== '/' || !url.searchParams.has('state')) {
        response.statusCode = 404
        response.end()
        return
      }
      const received = Buffer.from(url.searchParams.get('state') ?? ''),
        expected = Buffer.from(csrf)
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        response.statusCode = 400
        response.end('Invalid sign-in response.')
        return
      }
      const returned = url.searchParams.get('code')
      if (!returned || url.searchParams.has('error')) {
        response.statusCode = 400
        response.end('Sign-in did not complete. Return to SemaPath.')
        rejectCode(new AnalysisError('PBI_AUTH_FAILED'))
        return
      }
      response.end('Sign-in response received. You may return to SemaPath.')
      resolveCode(returned)
    })
    const stop = () => {
      server.closeAllConnections()
      server.close()
      rejectCode(signal.reason ?? new AnalysisError('PBI_CANCELLED'))
      if (this.client === client) {
        this.client = undefined
        state.active = null
        state.cache = ''
        try {
          this.persist()
        } catch {}
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      state.active = null
      this.persist()
      await abortable(
        new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        }),
        signal
      )
      const address = server.address()
      if (!address || typeof address === 'string') throw new AnalysisError('PBI_AUTH_FAILED')
      redirect = 'http://localhost:' + address.port
      const url = await abortable(
        client.getAuthCodeUrl({
          scopes,
          redirectUri: redirect,
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          state: csrf,
          prompt: 'select_account',
          responseMode: 'query'
        }),
        signal
      )
      const target = new URL(url),
        cloud = PBI_CLOUDS[application.environment]
      if (
        target.protocol !== 'https:' ||
        target.port ||
        target.username ||
        target.password ||
        !(cloud.authHosts as readonly string[]).includes(target.hostname)
      )
        throw new AnalysisError('PBI_AUTH_FAILED')
      signal.throwIfAborted()
      await this.openBrowser(url)
      const returned = await abortable(code, signal)
      const result = await abortable(
        client.acquireTokenByCode({
          scopes,
          redirectUri: redirect,
          code: returned,
          codeVerifier: verifier
        }),
        signal
      )
      if (epoch !== this.epoch || signal.aborted) throw new AnalysisError('PBI_ACCOUNT_CHANGED')
      if (!result.account || result.account.tenantId.toLowerCase() !== application.tenantId)
        throw new AnalysisError('PBI_AUTH_FAILED')
      state.active = result.account.homeAccountId
      state.cache = client.getTokenCache().serialize()
      this.persist()
      return this.status()
    } catch (error) {
      if (epoch === this.epoch) {
        this.client = undefined
        state.active = null
        state.cache = ''
        try {
          this.persist()
        } catch {}
      }
      if (error instanceof AnalysisError) throw error
      if (signal.aborted) throw signal.reason ?? new AnalysisError('PBI_CANCELLED')
      throw new AnalysisError('PBI_AUTH_FAILED')
    } finally {
      signal.removeEventListener('abort', stop)
      server.closeAllConnections()
      server.close()
      this.interactive = false
    }
  }
  async token(
    accountId: string,
    signal: AbortSignal
  ): Promise<{ accessToken: string; expiresOn: string }> {
    const epoch = this.epoch
    this.assertCurrent(accountId, epoch)
    const client = this.getClient(),
      state = this.load(),
      accounts = await abortable(client.getTokenCache().getAllAccounts(), signal)
    this.assertCurrent(accountId, epoch)
    const account = accounts.find(
      (a) =>
        a.homeAccountId === state.active && a.tenantId.toLowerCase() === this.application().tenantId
    )
    if (!account) throw new AnalysisError('PBI_AUTH_REQUIRED')
    let result: AuthenticationResult | null
    try {
      result = await abortable(
        client.acquireTokenSilent({ account, scopes: pbiScopes(this.application()) }),
        signal
      )
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof AnalysisError) throw error
      throw new AnalysisError('PBI_AUTH_REQUIRED')
    }
    this.assertCurrent(accountId, epoch)
    if (
      !result?.accessToken ||
      !result.expiresOn ||
      result.expiresOn.getTime() <= Date.now() + 30000
    )
      throw new AnalysisError('PBI_AUTH_REQUIRED')
    return { accessToken: result.accessToken, expiresOn: result.expiresOn.toISOString() }
  }
}

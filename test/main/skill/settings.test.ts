import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { SkillSettings } from '@/skill/settings'

describe('SkillSettings', () => {
  const values = new Map<string, unknown>()
  const store = {
    get: vi.fn((key: string) => values.get(key)),
    set: vi.fn((key: string, value: unknown) => values.set(key, value))
  }

  afterEach(() => vi.unstubAllEnvs())

  beforeEach(() => {
    vi.stubEnv('SEMAPATH_REPLICA_HOME', '')
    values.clear()
    vi.clearAllMocks()
    vi.mocked(app.getPath).mockReturnValue('/home/tester')
  })

  it('returns the Skill defaults', () => {
    const settings = new SkillSettings(store as never)

    expect(settings.isEnabled()).toBe(true)
    expect(settings.isDraftSuggestionsEnabled()).toBe(false)
    expect(settings.getPath()).toBe(path.join('/home/tester', '.semapath-replica', 'skills'))
  })

  it('keeps its default Skill library in the external replica home', () => {
    const home = path.resolve('external-test-cache', 'replica-home')
    vi.stubEnv('SEMAPATH_REPLICA_HOME', home)
    const settings = new SkillSettings(store as never)
    expect(settings.getPath()).toBe(path.join(home, 'skills'))
  })

  it('preserves an explicitly configured library instead of silently moving it', () => {
    const library = path.resolve('custom-skill-library')
    values.set('skillsPath', library)
    const settings = new SkillSettings(store as never)
    expect(settings.getPath()).toBe(library)
  })

  it('reads and writes Skill-owned settings', () => {
    const settings = new SkillSettings(store as never)
    const managementState = {
      version: 2 as const,
      agents: { deepchat: { skills: {} } }
    }
    const scanCache = { timestamp: '2026-07-16T00:00:00.000Z', tools: [] }

    settings.setDraftSuggestionsEnabled(true)
    settings.setManagementState(managementState)
    settings.setScanCache(scanCache)

    expect(settings.isDraftSuggestionsEnabled()).toBe(true)
    expect(settings.getManagementState()).toEqual(managementState)
    expect(settings.getScanCache()).toEqual(scanCache)
  })

  it('freezes legacy Agent migration targets once while preserving v1 state', () => {
    const settings = new SkillSettings(store as never)
    values.set('skills.managementState', {
      version: 1,
      skills: {},
      sync: { skillsDirectory: '/sync', layout: 'multi-skill-repo' }
    })

    settings.freezeLegacyMigrationTargets(['writer', 'analyst', 'writer', 'deepchat'], {
      writer: [' skill-b ', 'skill-a', 'skill-b'],
      ignored: ['other']
    })

    expect(values.get('skills.managementState')).toEqual({
      version: 1,
      skills: {},
      sync: { skillsDirectory: '/sync', layout: 'multi-skill-repo' },
      migration: {
        targetAgentIds: ['analyst', 'writer'],
        completedAgentIds: [],
        legacySkillAllowLists: {
          writer: ['skill-a', 'skill-b']
        }
      }
    })

    settings.freezeLegacyMigrationTargets(['created-later'])
    expect(
      (values.get('skills.managementState') as { migration: { targetAgentIds: string[] } })
        .migration.targetAgentIds
    ).toEqual(['analyst', 'writer'])
    expect(store.set).toHaveBeenCalledTimes(1)
  })
})

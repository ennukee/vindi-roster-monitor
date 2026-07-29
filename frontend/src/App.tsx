import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import './App.css'

type GearSlot = {
  slot: string
  itemLevel: number
}

type MythicPlusVaultSlot = {
  slot: number
  filled: boolean
  keyLevelHint?: number | null
}

type CharacterVaultBenchmarks = {
  mythicPlus?: {
    available?: boolean
    slots?: MythicPlusVaultSlot[]
  }
}

type MythicPlusDisplayCell = {
  value: string
  keyLevel: number | null
  filled: boolean
  available: boolean
}

type CharacterGear = {
  playerId: string
  name: string
  realm: string
  class: string
  spec: string
  status: string
  averageItemLevel: number | null
  slots: GearSlot[]
  vaultBenchmarks?: CharacterVaultBenchmarks | null
  error?: string
}

type MemberGear = {
  memberId: string
  displayName: string
  mainRole: string
  rank: string
  characters: CharacterGear[]
}

type FailedLookup = {
  name: string
  realm: string
  owner: string
  playerId: string
  error: string
}

type RunAction = {
  timestamp: string
  step: string
  message: string
  meta?: Record<string, unknown>
}

type RunLog = {
  runId: string
  startedAt: string
  finishedAt: string | null
  success: boolean
  error: string | null
  actions: RunAction[]
  summary?: Record<string, unknown>
}

type LogsPayload = {
  updatedAt: string
  retentionDays: number
  runs: RunLog[]
}

type GearPayload = {
  groupId: string
  exportedAt: string | null
  generatedAt: string | null
  memberCount: number
  characterCount: number
  queriedCharacters: number
  failedLookupCount?: number
  failedLookups?: FailedLookup[]
  region: string
  locale: string
  members: MemberGear[]
}

type CharacterRow = {
  owner: string
  characterName: string
  realmName: string
  averageItemLevel: number | null
  mythicPlusVaultSlots: MythicPlusDisplayCell[]
  slotItemLevels: Record<string, number>
  error?: string
}

const VAULT_SLOT_NUMBERS = [1, 2, 3]

const SLOT_ORDER = [
  'HEAD',
  'NECK',
  'SHOULDER',
  'BACK',
  'CHEST',
  'WRIST',
  'HANDS',
  'WAIST',
  'LEGS',
  'FEET',
  'FINGER_1',
  'FINGER_2',
  'TRINKET_1',
  'TRINKET_2',
  'MAIN_HAND',
  'OFF_HAND',
]

const EXCLUDED_SLOT_COLUMNS = new Set(['SHIRT', 'TABARD'])

function formatSlotLabel(slot: string) {
  return slot
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function stripApostrophes(value: string) {
  return value.replace(/[\u2019'`]/g, '')
}

function formatRealmName(value: string) {
  return value
    .split(/([\s-]+)/)
    .map((token) => {
      if (/^[\s-]+$/.test(token) || token.length === 0) {
        return token
      }

      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
    })
    .join('')
}

function formatMythicPlusVaultSlot(
  vaultBenchmarks: CharacterVaultBenchmarks | null | undefined,
  slotNumber: number,
) : MythicPlusDisplayCell {
  const mythicBenchmarks = vaultBenchmarks?.mythicPlus
  if (!mythicBenchmarks?.available) {
    return {
      value: '-',
      keyLevel: null,
      filled: false,
      available: false,
    }
  }

  const slot = mythicBenchmarks.slots?.find((entry) => entry.slot === slotNumber)
  if (!slot) {
    return {
      value: '-',
      keyLevel: null,
      filled: false,
      available: true,
    }
  }

  if (!slot.filled) {
    return {
      value: '',
      keyLevel: null,
      filled: false,
      available: true,
    }
  }

  if (typeof slot.keyLevelHint === 'number') {
    return {
      value: `+${slot.keyLevelHint}`,
      keyLevel: slot.keyLevelHint,
      filled: true,
      available: true,
    }
  }

  return {
    value: 'Yes',
    keyLevel: null,
    filled: true,
    available: true,
  }
}

function getMythicPlusCellStyle(cell: MythicPlusDisplayCell): CSSProperties | undefined {
  if (!cell.available) {
    return undefined
  }

  if (!cell.filled) {
    return {
      background: '#f3caca',
      color: '#6a1d1d',
      fontWeight: 650,
    }
  }

  if (cell.keyLevel !== null && cell.keyLevel > 10) {
    return {
      background: '#d8f8dd',
      color: '#124f22',
      fontWeight: 700,
    }
  }

  if (cell.keyLevel !== null && cell.keyLevel >= 2 && cell.keyLevel <= 9) {
    const t = (cell.keyLevel - 2) / 7
    const lightness = 97 - t * 11
    return {
      background: `hsl(42 100% ${lightness}%)`,
      color: '#5d3b00',
      fontWeight: 650,
    }
  }

  if (cell.keyLevel === 10) {
    return {
      background: '#e6efff',
      color: '#1f3d66',
      fontWeight: 650,
    }
  }

  return {
    fontWeight: 650,
  }
}

function App() {
  const [payload, setPayload] = useState<GearPayload | null>(null)
  const [logsPayload, setLogsPayload] = useState<LogsPayload | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSlots, setShowSlots] = useState(false)
  const [showLogs, setShowLogs] = useState(false)

  useEffect(() => {
    let mounted = true

    async function loadGear() {
      try {
        const response = await fetch('/data/gear.json', {
          headers: { Accept: 'application/json' },
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }

        const json = (await response.json()) as GearPayload
        if (mounted) {
          setPayload(json)
          setError(null)
        }
      } catch (loadError) {
        if (mounted) {
          const message = loadError instanceof Error ? loadError.message : 'Unknown error'
          setError(message)
        }
      }
    }

    async function loadLogs() {
      try {
        const response = await fetch('/data/logs.json', {
          headers: { Accept: 'application/json' },
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }

        const json = (await response.json()) as LogsPayload
        if (mounted) {
          setLogsPayload(json)
          setLogsError(null)
        }
      } catch (loadError) {
        if (mounted) {
          const message = loadError instanceof Error ? loadError.message : 'Unknown error'
          setLogsError(message)
        }
      }
    }

    loadGear()
    loadLogs()
    return () => {
      mounted = false
    }
  }, [])

  const rows = useMemo<CharacterRow[]>(() => {
    if (!payload) {
      return []
    }

    return payload.members.flatMap((member) =>
      member.characters.map((character) => ({
        owner: member.displayName,
        characterName: stripApostrophes(character.name),
        realmName: formatRealmName(stripApostrophes(character.realm)),
        averageItemLevel: character.averageItemLevel,
        mythicPlusVaultSlots: VAULT_SLOT_NUMBERS.map((slotNumber) =>
          formatMythicPlusVaultSlot(character.vaultBenchmarks, slotNumber),
        ),
        slotItemLevels: Object.fromEntries(character.slots.map((slot) => [slot.slot, slot.itemLevel])),
        error: character.error,
      })),
    )
  }, [payload])

  const visibleRows = useMemo(
    () => rows.filter((row) => !/HTTP\s+404/i.test(row.error || '')),
    [rows],
  )

  const slotColumns = useMemo(() => {
    const seen = new Set<string>()
    for (const row of visibleRows) {
      for (const slot of Object.keys(row.slotItemLevels)) {
        if (EXCLUDED_SLOT_COLUMNS.has(slot)) {
          continue
        }

        seen.add(slot)
      }
    }

    return [...seen].sort((a, b) => {
      const aIndex = SLOT_ORDER.indexOf(a)
      const bIndex = SLOT_ORDER.indexOf(b)
      const aKnown = aIndex !== -1
      const bKnown = bIndex !== -1

      if (aKnown && bKnown) {
        return aIndex - bIndex
      }

      if (aKnown) {
        return -1
      }

      if (bKnown) {
        return 1
      }

      return a.localeCompare(b)
    })
  }, [visibleRows])

  const failedLookups = payload?.failedLookups ?? []

  return (
    <main className="app-page">
      <section className="toolbar-row">
        <label className="toggle">
          <input type="checkbox" checked={showSlots} onChange={(event) => setShowSlots(event.target.checked)} />
          Show slot columns
        </label>
        <button className="logs-button" type="button" onClick={() => setShowLogs((value) => !value)}>
          {showLogs ? 'Hide logs' : 'View logs'}
        </button>
      </section>

      {error ? <p className="error global-error">Failed to load /data/gear.json: {error}</p> : null}
      {logsError ? <p className="error global-error">Failed to load /data/logs.json: {logsError}</p> : null}

      {failedLookups.length > 0 ? (
        <section className="warning-strip" role="status">
          <strong>Missing character profiles ({failedLookups.length}):</strong>{' '}
          {failedLookups
            .map((entry) => `${stripApostrophes(entry.name)}-${stripApostrophes(entry.realm)}`)
            .join(', ')}
        </section>
      ) : null}

      {showLogs ? (
        <section className="logs-panel">
          <h2>Run Logs (Last {logsPayload?.retentionDays ?? 7} days)</h2>
          {logsPayload?.runs?.length ? (
            <ul className="logs-list">
              {logsPayload.runs.slice(0, 20).map((run) => (
                <li className="log-run" key={run.runId}>
                  <p>
                    <strong>{run.success ? 'Success' : 'Failed'}</strong> • {new Date(run.startedAt).toLocaleString()}
                  </p>
                  {run.error ? <p className="row-error">{run.error}</p> : null}
                  <details>
                    <summary>Actions ({run.actions?.length ?? 0})</summary>
                    <ul className="action-list">
                      {(run.actions || []).map((action, index) => (
                        <li key={`${run.runId}-${index}`}>
                          <span>{new Date(action.timestamp).toLocaleTimeString()}</span>
                          <span>{action.step}</span>
                          <span>{action.message}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No logs available yet.</p>
          )}
        </section>
      ) : null}

      <section className="table-stage">
        {!payload || visibleRows.length === 0 ? (
          <p className="empty">No member data found.</p>
        ) : (
          <div className="table-wrap">
            <table className="gear-table">
              <thead>
                <tr>
                  <th>Owner</th>
                  <th>Character</th>
                  <th>Realm</th>
                  <th>Avg iLvl</th>
                  {VAULT_SLOT_NUMBERS.map((slotNumber) => (
                    <th key={`mplus-slot-${slotNumber}`}>M+ {slotNumber}</th>
                  ))}
                  {showSlots ? slotColumns.map((slot) => <th key={slot}>{formatSlotLabel(slot)}</th>) : null}
                  <th className="table-filler" aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={`${row.owner}-${row.characterName}-${row.realmName}`}>
                    <td>{row.owner}</td>
                    <td>
                      {row.characterName}
                      {row.error ? <span className="row-error"> • {row.error}</span> : null}
                    </td>
                    <td>{row.realmName}</td>
                    <td className="number-cell">{row.averageItemLevel ?? 'n/a'}</td>
                    {row.mythicPlusVaultSlots.map((cell, index) => (
                      <td
                        className="vault-cell"
                        style={getMythicPlusCellStyle(cell)}
                        key={`${row.characterName}-${row.realmName}-mplus-${index + 1}`}
                      >
                        {cell.value}
                      </td>
                    ))}
                    {showSlots
                      ? slotColumns.map((slot) => (
                          <td className="number-cell" key={`${row.characterName}-${row.realmName}-${slot}`}>
                            {row.slotItemLevels[slot] ?? '-'}
                          </td>
                        ))
                      : null}
                    <td className="table-filler" aria-hidden="true"></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

export default App

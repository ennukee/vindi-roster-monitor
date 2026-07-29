function getSlotThresholds() {
  return {
    raid: [2, 4, 6],
    mythicPlus: [1, 4, 8],
  }
}

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function getWeeklyResetConfig(region) {
  const normalized = String(region || "us").toLowerCase()
  const byRegion = {
    us: { dayOfWeek: 2, hourUtc: 17 },
    eu: { dayOfWeek: 3, hourUtc: 7 },
    kr: { dayOfWeek: 4, hourUtc: 0 },
    tw: { dayOfWeek: 4, hourUtc: 0 },
  }

  const defaults = byRegion[normalized] || byRegion.us
  const envDayRaw = Number(process.env.BLIZZ_WEEKLY_RESET_UTC_DAY)
  const envHourRaw = Number(process.env.BLIZZ_WEEKLY_RESET_UTC_HOUR)
  const envDay = Number.isFinite(envDayRaw) ? envDayRaw : null
  const envHour = Number.isFinite(envHourRaw) ? envHourRaw : null

  return {
    dayOfWeek: envDay !== null ? Math.max(0, Math.min(6, envDay)) : defaults.dayOfWeek,
    hourUtc: envHour !== null ? Math.max(0, Math.min(23, envHour)) : defaults.hourUtc,
  }
}

function getMostRecentWeeklyResetUtc(region) {
  const now = new Date()
  const { dayOfWeek, hourUtc } = getWeeklyResetConfig(region)

  const reset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    0,
    0,
    0,
  ))

  const daysBack = (now.getUTCDay() - dayOfWeek + 7) % 7
  reset.setUTCDate(reset.getUTCDate() - daysBack)

  if (reset.getTime() > now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() - 7)
  }

  return reset
}

function getDifficultyRank(difficulty) {
  const value = String(difficulty || "").toLowerCase()
  if (value.includes("mythic")) {
    return 4
  }

  if (value.includes("heroic")) {
    return 3
  }

  if (value.includes("normal")) {
    return 2
  }

  if (value.includes("raid finder") || value.includes("lfr")) {
    return 1
  }

  return 0
}

function getCurrentRaidInstance(raidPayload) {
  const expansions = Array.isArray(raidPayload?.expansions) ? raidPayload.expansions : []
  const latestExpansion = expansions[expansions.length - 1]
  const instances = Array.isArray(latestExpansion?.instances) ? latestExpansion.instances : []
  return instances[instances.length - 1] || null
}

function buildRaidBenchmarks(raidPayload, region) {
  const thresholds = getSlotThresholds().raid
  const raidInstance = getCurrentRaidInstance(raidPayload)
  const modes = Array.isArray(raidInstance?.modes) ? raidInstance.modes : []
  const weeklyReset = getMostRecentWeeklyResetUtc(region)
  const weeklyResetMs = weeklyReset.getTime()

  const bossKills = new Map()

  for (const mode of modes) {
    const difficulty =
      mode?.difficulty?.name || mode?.difficulty?.type || mode?.type || mode?.name || "Unknown"
    const encounters = Array.isArray(mode?.progress?.encounters) ? mode.progress.encounters : []

    for (const encounter of encounters) {
      const lastKillTimestamp = toNumber(encounter?.last_kill_timestamp)
      if (lastKillTimestamp === null || lastKillTimestamp < weeklyResetMs) {
        continue
      }

      const bossId = encounter?.encounter?.id || encounter?.encounter?.name
      if (!bossId) {
        continue
      }

      const current = bossKills.get(bossId)
      const next = {
        lastKillTimestamp,
        difficulty,
        difficultyRank: getDifficultyRank(difficulty),
      }

      if (!current || next.lastKillTimestamp > current.lastKillTimestamp || next.difficultyRank > current.difficultyRank) {
        bossKills.set(bossId, next)
      }
    }
  }

  const bossesEstimate = bossKills.size
  const highestDifficulty = [...bossKills.values()].reduce((best, kill) => {
    if (!best || kill.difficultyRank > best.difficultyRank) {
      return kill
    }

    return best
  }, null)

  return {
    available: true,
    source: "encounters/raids",
    approximation: "Counts unique boss kills since regional weekly reset from the latest raid instance.",
    resetAtUtc: weeklyReset.toISOString(),
    raidInstanceHint: raidInstance?.instance?.name || raidInstance?.name || null,
    difficultyHint: highestDifficulty?.difficulty || null,
    bossesEstimate,
    slots: thresholds.map((requiredBosses, index) => ({
      slot: index + 1,
      filled: bossesEstimate >= requiredBosses,
      requiredBosses,
      bossesEstimate,
      difficultyHint: highestDifficulty?.difficulty || null,
    })),
  }
}

function collectMythicRunLevels(profilePayload) {
  const runs = []
  const seen = new Set()

  const normalizeTimestamp = (value) => {
    const numeric = toNumber(value)
    if (numeric !== null) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
    }

    if (typeof value === "string") {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }

    return null
  }

  const addRuns = (candidateRuns) => {
    if (!Array.isArray(candidateRuns)) {
      return
    }

    for (const run of candidateRuns) {
      const level = toNumber(run?.keystone_level)
      if (level !== null) {
        const completedTimestamp =
          normalizeTimestamp(run?.completed_timestamp) ??
          normalizeTimestamp(run?.completion_timestamp) ??
          normalizeTimestamp(run?.completed_at) ??
          normalizeTimestamp(run?.end_timestamp) ??
          normalizeTimestamp(run?.timestamp) ??
          normalizeTimestamp(run?.start_timestamp)

        runs.push({
          level,
          completedTimestamp,
        })
      }
    }
  }

  const queue = [profilePayload]
  while (queue.length > 0) {
    const node = queue.pop()
    if (!node || typeof node !== "object") {
      continue
    }

    if (seen.has(node)) {
      continue
    }
    seen.add(node)

    addRuns(node.best_runs)
    addRuns(node.runs)
    addRuns(node.completed_runs)

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        queue.push(value)
      }
    }
  }

  return runs
}

function buildMythicPlusBenchmarks(mythicPayload, region) {
  const thresholds = getSlotThresholds().mythicPlus
  const weeklyReset = getMostRecentWeeklyResetUtc(region)
  const weeklyResetMs = weeklyReset.getTime()

  const runLevels = collectMythicRunLevels(mythicPayload)
    .filter((run) => run.completedTimestamp !== null && run.completedTimestamp >= weeklyResetMs)
    .map((run) => run.level)
    .sort((a, b) => b - a)

  const completedRunsEstimate = runLevels.length

  return {
    available: true,
    source: "mythic-keystone-profile",
    approximation: "Counts Mythic+ runs completed since regional weekly reset.",
    resetAtUtc: weeklyReset.toISOString(),
    completedRunsEstimate,
    topRunLevels: runLevels.slice(0, 10),
    slots: thresholds.map((requiredRuns, index) => ({
      slot: index + 1,
      filled: completedRunsEstimate >= requiredRuns,
      requiredRuns,
      completedRunsEstimate,
      keyLevelHint: runLevels[requiredRuns - 1] ?? null,
    })),
  }
}

async function fetchBlizzardProfileJson({ endpoint, region, namespace, locale, accessToken }) {
  const url =
    `https://${region}.api.blizzard.com${endpoint}` +
    `?namespace=${encodeURIComponent(namespace)}&locale=${encodeURIComponent(locale)}`

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    const error = new Error(`HTTP ${response.status} ${response.statusText}: ${errorBody}`)
    error.status = response.status
    throw error
  }

  return response.json()
}

async function fetchCharacterVaultBenchmarks({
  realmSlug,
  characterSlug,
  region,
  locale,
  accessToken,
  logAction,
}) {
  const namespace = `profile-${region}`

  const raidPath = `/profile/wow/character/${realmSlug}/${characterSlug}/encounters/raids`
  const mythicPath = `/profile/wow/character/${realmSlug}/${characterSlug}/mythic-keystone-profile`

  const result = {
    generatedAt: new Date().toISOString(),
    isApproximation: true,
    raid: {
      available: false,
      source: "encounters/raids",
      error: null,
      slots: [],
    },
    mythicPlus: {
      available: false,
      source: "mythic-keystone-profile",
      error: null,
      slots: [],
    },
  }

  try {
    const raidPayload = await fetchBlizzardProfileJson({
      endpoint: raidPath,
      region,
      namespace,
      locale,
      accessToken,
    })
    result.raid = buildRaidBenchmarks(raidPayload, region)
  } catch (error) {
    result.raid.error = error.message
    if (typeof logAction === "function") {
      logAction("vault-raid-error", "Raid benchmark fetch failed", {
        realmSlug,
        characterSlug,
        error: error.message,
      })
    }
  }

  try {
    const mythicPayload = await fetchBlizzardProfileJson({
      endpoint: mythicPath,
      region,
      namespace,
      locale,
      accessToken,
    })
    result.mythicPlus = buildMythicPlusBenchmarks(mythicPayload, region)
  } catch (error) {
    result.mythicPlus.error = error.message
    if (typeof logAction === "function") {
      logAction("vault-mplus-error", "Mythic+ benchmark fetch failed", {
        realmSlug,
        characterSlug,
        error: error.message,
      })
    }
  }

  return result
}

module.exports = {
  fetchCharacterVaultBenchmarks,
}

require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { fetchCharacterVaultBenchmarks } = require("./vault-benchmarks");

const wowutilsRosterUrl = "https://api.wowutils.com/v1/groups/66ea6073d591ccc2b384a1ee/roster";
const wowutilsApiKey = process.env.WOWUTILS_API_KEY;
const blizzClientId = process.env.BLIZZ_API_CLIENT_ID;
const blizzClientSecret = process.env.BLIZZ_API_CLIENT_SECRET;

const region = process.env.BLIZZ_REGION || "us";
const locale = process.env.BLIZZ_LOCALE || "en_US";
const delayMs = Number(process.env.BLIZZ_REQUEST_DELAY_MS || "250");
const logRetentionDays = Number(process.env.LOG_RETENTION_DAYS || "7");

const privateDataDir = path.join(__dirname, "data");
const privateRosterPath = path.join(privateDataDir, "roster.filtered.json");

const publicDataDir = path.join(__dirname, "..", "frontend", "public", "data");
const publicGearPath = path.join(publicDataDir, "gear.json");
const publicLogsPath = path.join(publicDataDir, "logs.json");
const publicCharactersCsvPath = path.join(publicDataDir, "characters.csv");

const allowedStatuses = new Set(["main", "alt"]);

const runContext = {
	runId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	startedAt: new Date().toISOString(),
	finishedAt: null,
	success: false,
	error: null,
	actions: [],
	summary: {},
};

function logAction(step, message, meta = {}) {
	runContext.actions.push({
		timestamp: new Date().toISOString(),
		step,
		message,
		meta,
	});
}

async function readJsonFile(filePath) {
	try {
		const content = await fs.readFile(filePath, "utf8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

function pruneOldRuns(runs) {
	const retentionMs = logRetentionDays * 24 * 60 * 60 * 1000;
	const cutoff = Date.now() - retentionMs;

	return runs.filter((run) => {
		const timestamp = Date.parse(run.startedAt || "");
		return Number.isFinite(timestamp) && timestamp >= cutoff;
	});
}

async function persistRunLogs() {
	await fs.mkdir(publicDataDir, { recursive: true });

	const existing = (await readJsonFile(publicLogsPath)) || { runs: [] };
	const previousRuns = Array.isArray(existing.runs) ? existing.runs : [];
	const retainedRuns = pruneOldRuns(previousRuns);
	const nextRuns = [runContext, ...retainedRuns].sort(
		(a, b) => Date.parse(b.startedAt || "") - Date.parse(a.startedAt || ""),
	);

	const logsPayload = {
		updatedAt: new Date().toISOString(),
		retentionDays: logRetentionDays,
		runs: nextRuns,
	};

	await fs.writeFile(publicLogsPath, JSON.stringify(logsPayload, null, 2), "utf8");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
	return String(value || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[\u2019'`]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function stripApostrophes(value) {
	return String(value || "").replace(/[\u2019'`]/g, "");
}

function escapeCsvCell(value) {
	const text = String(value ?? "");
	if (/[",\n\r]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}

	return text;
}

function buildCharactersCsv(gearData) {
	const header = ["owner", "character", "realm", "character_realm", "avg_ilvl"];
	const rows = [header.join(",")];

	for (const member of gearData.members || []) {
		for (const character of member.characters || []) {
			const owner = member.displayName || "";
			const name = character.name || "";
			const realm = character.realm || "";
			const characterRealm = `${name}-${realm}`;
			const avgIlvl = typeof character.averageItemLevel === "number" ? character.averageItemLevel : "";

			const row = [owner, name, realm, characterRealm, avgIlvl].map(escapeCsvCell).join(",");
			rows.push(row);
		}
	}

	return `${rows.join("\n")}\n`;
}

function filterRosterData(data) {
	const members = Array.isArray(data?.members)
		? data.members.map((member) => {
			const characters = Array.isArray(member?.characters)
				? member.characters.filter((character) =>
					allowedStatuses.has(String(character?.status || "").toLowerCase()),
				)
				: [];

			return {
				...member,
				characters,
			};
		})
		: [];

	const characterCount = members.reduce(
		(total, member) => total + member.characters.length,
		0,
	);

	return {
		...data,
		members,
		memberCount: members.length,
		characterCount,
	};
}

async function getBlizzardAccessToken() {
	logAction("blizzard-oauth", "Requesting Blizzard OAuth token", { region });
	const oauthUrl = `https://${region}.battle.net/oauth/token`;
	const basicAuth = Buffer.from(`${blizzClientId}:${blizzClientSecret}`).toString("base64");

	const response = await fetch(oauthUrl, {
		method: "POST",
		headers: {
			Authorization: `Basic ${basicAuth}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ grant_type: "client_credentials" }),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Blizzard OAuth failed: HTTP ${response.status} ${response.statusText}: ${errorBody}`);
	}

	const payload = await response.json();
	if (!payload?.access_token) {
		throw new Error("Blizzard OAuth response missing access_token");
	}

	logAction("blizzard-oauth", "Received Blizzard OAuth token");

	return payload.access_token;
}

function normalizeGearResponse(character, equipmentData) {
	const equippedItems = Array.isArray(equipmentData?.equipped_items)
		? equipmentData.equipped_items
		: [];
	const excludedAverageSlots = new Set(["TABARD", "SHIRT"]);
	const normalizedClass = String(character?.class || "").toLowerCase();
	const normalizedSpec = String(character?.spec || "").toLowerCase();
	const isFuryWarrior = normalizedClass === "warrior" && normalizedSpec === "fury";

	const getSlotType = (item) => String(item?.slot?.type || item?.slot?.name || "").toUpperCase();
	const getItemLevel = (item) => (typeof item?.level?.value === "number" ? item.level.value : null);
	const isTwoHandWeapon = (item) => {
		const inventoryType = String(item?.inventory_type?.type || item?.inventory_type?.name || "").toUpperCase();
		return inventoryType.includes("2H") || inventoryType.includes("TWOH");
	};

	let totalItemLevel = 0;
	let mainHand = null;
	let offHand = null;

	for (const item of equippedItems) {
		const slotType = getSlotType(item);
		const itemLevel = getItemLevel(item);

		if (itemLevel === null) {
			continue;
		}

		if (excludedAverageSlots.has(slotType)) {
			continue;
		}

		if (slotType === "MAIN_HAND") {
			mainHand = item;
			continue;
		}

		if (slotType === "OFF_HAND") {
			offHand = item;
			continue;
		}

		totalItemLevel += itemLevel;
	}

	const mainHandLevel = mainHand ? getItemLevel(mainHand) : null;
	const offHandLevel = offHand ? getItemLevel(offHand) : null;

	if (mainHandLevel !== null && offHandLevel !== null) {
		totalItemLevel += mainHandLevel + offHandLevel;
	} else if (mainHandLevel !== null) {
		totalItemLevel += mainHandLevel;
		if (isTwoHandWeapon(mainHand) && !isFuryWarrior) {
			totalItemLevel += mainHandLevel;
		}
	} else if (offHandLevel !== null) {
		totalItemLevel += offHandLevel;
	}

	const slots = equippedItems
		.map((item) => {
			const slot = item?.slot?.type || item?.slot?.name;
			const itemLevel = item?.level?.value;
			if (!slot || typeof itemLevel !== "number") {
				return null;
			}

			return {
				slot,
				itemLevel,
				inventoryType: item?.inventory_type?.type || item?.inventory_type?.name || null,
			};
		})
		.filter(Boolean);

	const averageItemLevel = Number((totalItemLevel / 16).toFixed(2));

	return {
		playerId: character.playerId,
		name: stripApostrophes(character.name),
		realm: stripApostrophes(character.realm),
		class: character.class,
		spec: character.spec,
		status: character.status,
		averageItemLevel,
		slots,
	};
}

async function fetchCharacterGear(character, accessToken) {
	logAction("character-fetch", "Fetching character equipment", {
		playerId: character.playerId,
		name: character.name,
		realm: character.realm,
	});

	const realmSlug = slugify(character.realm);
	const characterSlug = slugify(character.name);
	const namespace = `profile-${region}`;

	const equipmentUrl =
		`https://${region}.api.blizzard.com/profile/wow/character/${realmSlug}/${characterSlug}/equipment` +
		`?namespace=${namespace}&locale=${encodeURIComponent(locale)}`;

	const response = await fetch(equipmentUrl, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		const errorBody = await response.text();
		const requestError = new Error(`HTTP ${response.status} ${response.statusText}: ${errorBody}`);
		requestError.status = response.status;
		throw requestError;
	}

	const equipmentData = await response.json();
	logAction("character-fetch", "Fetched character equipment", {
		playerId: character.playerId,
		name: character.name,
		realm: character.realm,
	});

	const normalizedGear = normalizeGearResponse(character, equipmentData);

	const vaultBenchmarks = await fetchCharacterVaultBenchmarks({
		realmSlug,
		characterSlug,
		region,
		locale,
		accessToken,
		logAction,
	});

	return {
		...normalizedGear,
		vaultBenchmarks,
	};
}

async function enrichRosterWithGear(filteredRoster, accessToken) {
	logAction("enrichment", "Starting gear enrichment", {
		members: filteredRoster?.memberCount || 0,
		characters: filteredRoster?.characterCount || 0,
	});

	const gearCache = new Map();
	const membersWithGear = [];
	const failedLookups = [];
	const failedLookupSet = new Set();
	let queriedCharacters = 0;

	for (const member of filteredRoster.members) {
		logAction("member-enrichment", "Processing member", {
			memberId: member.memberId,
			displayName: member.displayName,
			characterCount: Array.isArray(member.characters) ? member.characters.length : 0,
		});

		const enrichedCharacters = [];

		for (const character of member.characters) {
			const cacheKey = character.playerId || `${character.name}-${character.realm}`;

			if (gearCache.has(cacheKey)) {
				logAction("character-cache", "Using cached character result", {
					playerId: character.playerId,
				});

				enrichedCharacters.push(gearCache.get(cacheKey));
				continue;
			}

			try {
				const gearData = await fetchCharacterGear(character, accessToken);
				gearCache.set(cacheKey, gearData);
				enrichedCharacters.push(gearData);
				queriedCharacters += 1;
			} catch (error) {
				logAction("character-fetch-error", "Character fetch failed", {
					playerId: character.playerId,
					name: character.name,
					realm: character.realm,
					error: error.message,
				});

				const isNotFound = error.status === 404 || /HTTP\s+404/i.test(String(error.message || ""));
				if (isNotFound) {
					const failedKey = `${character.name}|${character.realm}`.toLowerCase();
					if (!failedLookupSet.has(failedKey)) {
						failedLookupSet.add(failedKey);
						failedLookups.push({
							name: stripApostrophes(character.name),
							realm: stripApostrophes(character.realm),
							owner: member.displayName,
							playerId: character.playerId,
							error: error.message,
						});
					}
				}

				enrichedCharacters.push({
					playerId: character.playerId,
					name: stripApostrophes(character.name),
					realm: stripApostrophes(character.realm),
					class: character.class,
					spec: character.spec,
					status: character.status,
					averageItemLevel: null,
					slots: [],
					vaultBenchmarks: null,
					error: error.message,
				});
			}

			await sleep(delayMs);
		}

		membersWithGear.push({
			memberId: member.memberId,
			displayName: member.displayName,
			alias: member.alias,
			battletag: member.battletag,
			rank: member.rank,
			mainRole: member.mainRole,
			mainCharacter: member.mainCharacter,
			characters: enrichedCharacters,
		});
	}

	logAction("enrichment", "Completed gear enrichment", {
		queriedCharacters,
		failedLookupCount: failedLookups.length,
	});

	return {
		groupId: filteredRoster.groupId,
		exportedAt: filteredRoster.exportedAt,
		generatedAt: new Date().toISOString(),
		memberCount: membersWithGear.length,
		characterCount: membersWithGear.reduce((total, member) => total + member.characters.length, 0),
		queriedCharacters,
		failedLookupCount: failedLookups.length,
		failedLookups,
		region,
		locale,
		members: membersWithGear,
	};
}

async function getRoster() {
	try {
		logAction("run-start", "Started roster pipeline", {
			region,
			locale,
			delayMs,
			retentionDays: logRetentionDays,
		});

		if (!wowutilsApiKey) {
			throw new Error("Missing WOWUTILS_API_KEY in .env");
		}

		if (!blizzClientId || !blizzClientSecret) {
			throw new Error("Missing BLIZZ_API_CLIENT_ID or BLIZZ_API_CLIENT_SECRET in .env");
		}

		logAction("wowutils-fetch", "Fetching wowutils roster");

		const response = await fetch(wowutilsRosterUrl, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${wowutilsApiKey}`,
			},
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorBody}`);
		}

		logAction("wowutils-fetch", "Received wowutils roster response", {
			status: response.status,
		});

		const rawData = await response.json();
		logAction("wowutils-parse", "Parsed wowutils roster JSON");

		const filteredData = filterRosterData(rawData);
		logAction("roster-filter", "Filtered roster to main/alt characters", {
			members: filteredData.memberCount,
			characters: filteredData.characterCount,
		});

		const accessToken = await getBlizzardAccessToken();
		const gearData = await enrichRosterWithGear(filteredData, accessToken);

		await fs.mkdir(privateDataDir, { recursive: true });
		await fs.writeFile(privateRosterPath, JSON.stringify(filteredData, null, 2), "utf8");
		logAction("private-write", "Wrote private filtered roster", { path: privateRosterPath });

		await fs.mkdir(publicDataDir, { recursive: true });
		await fs.writeFile(publicGearPath, JSON.stringify(gearData, null, 2), "utf8");
		logAction("public-write", "Wrote public gear snapshot", { path: publicGearPath });

		const charactersCsv = buildCharactersCsv(gearData);
		await fs.writeFile(publicCharactersCsvPath, charactersCsv, "utf8");
		logAction("public-write", "Wrote public character CSV", { path: publicCharactersCsvPath });

		runContext.summary = {
			memberCount: gearData.memberCount,
			characterCount: gearData.characterCount,
			failedLookupCount: gearData.failedLookupCount,
		};
		runContext.success = true;

		console.log("Status:", response.status, response.statusText);
		console.log("Saved private filtered roster to", privateRosterPath);
		console.log("Saved public gear snapshot to", publicGearPath);
		console.log("Saved public character CSV to", publicCharactersCsvPath);
	} catch (error) {
		runContext.success = false;
		runContext.error = error.message;
		logAction("run-error", "Pipeline failed", { error: error.message });

		console.error("Request failed:", error.message);
		process.exitCode = 1;
	} finally {
		runContext.finishedAt = new Date().toISOString();
		logAction("run-end", "Finished roster pipeline", {
			success: runContext.success,
			error: runContext.error,
		});

		await persistRunLogs();
		console.log("Saved run logs to", publicLogsPath);
	}
}

getRoster();

import Cache, { SECOND } from "better-memory-cache";
import Harvest from "harvest";
import { z } from "zod";
import { harvestRateLimit, type UpdateType } from "./limits";
import { logMessage } from "./logging";
import { NotionCard } from "./NotionCard";
import { clientNamesMatch, taskNamesMatch } from "./util";

const accessToken = Bun.env.HARVEST_TOKEN;
const accountId = Bun.env.ACCOUNT_ID;
if (!accessToken || !accountId) {
	throw new Error("Missing harvest credentials");
}

const harvest = new Harvest({
	subdomain: "reformcollective",
	userAgent: "NotionSync (robbie@reformcollective.com)",
	concurrency: 1,
	auth: {
		accessToken,
		accountId,
	},
});

const timeEntrySchema = z.object({
	client: z.object({ name: z.string() }),
	hours: z.number(),
	notes: z.string(),
});

const processBulkUpdate = async (
	entries: Array<{ client: { name: string }; hours: number; notes: string }>,
) => {
	let processed = 0;
	const total = entries.length;

	logMessage(`[BULK] Starting bulk update of ${total} entries`);

	const chunkSize = 100;
	for (let i = 0; i < entries.length; i += chunkSize) {
		const chunk = entries.slice(i, i + chunkSize);

		await Promise.all(
			chunk.map(async (entry) => {
				const card = await NotionCard.getOrCreate(
					{
						name: entry.notes,
						project: entry.client.name,
					},
					"bulk",
				);
				await card?.update("bulk");
			}),
		);

		processed += chunk.length;
		logMessage(`[BULK] Processed ${processed}/${total} cards`);
	}

	logMessage(
		`[BULK] Bulk update complete: ${processed}/${total} cards processed`,
	);
};

const interval = 2 * 1000;
let lastCheck: string | undefined;
export const startWatching = async () => {
	const waiting =
		// wait at least 5 seconds between each request
		new Promise((resolve) => setTimeout(resolve, interval));

	const checkTime = lastCheck;
	lastCheck = new Date(Date.now() - interval).toISOString();

	await harvestRateLimit("realtime");
	const updatedEntriesRequest = await harvest.timeEntries.list({
		updated_since: checkTime,
		is_running: false,
	});
	await harvestRateLimit("realtime");
	const runningEntriesRequest = await harvest.timeEntries.list({
		is_running: true,
	});

	const entries = [
		...updatedEntriesRequest.time_entries,
		...runningEntriesRequest.time_entries,
	]
		.map((e) => timeEntrySchema.safeParse(e))
		.filter((e) => e.success)
		.map((e) => e.data)
		.filter((c) => c.client.name !== "Underbelly")
		.filter((c) => c.client.name !== "Underbelly (Square)");

	const updateType: UpdateType = entries.length > 100 ? "bulk" : "realtime";

	if (entries.length > 0) {
		if (updateType === "realtime") {
			logMessage("[LOOP] found", entries.length, "entries");
		}
	} else {
		logMessage("[LOOP] no entries found");
	}

	if (updateType === "bulk") {
		// Background bulk update - don't await
		processBulkUpdate(entries);
	} else {
		// Realtime updates - await for immediate processing
		await Promise.all(
			entries.map(async (e) => {
				const card = await NotionCard.getOrCreate(
					{
						name: e.notes,
						project: e.client.name,
					},
					updateType,
				);
				await card?.update(updateType);
			}),
		);
	}

	await waiting;

	startWatching();
};

const clientSchema = z.object({
	clients: z.object({ id: z.number(), name: z.string() }).array(),
});

const runGetHoursByName = async ({
	taskName,
	clientName,
	updateType,
}: {
	clientName: string;
	taskName: string;
	updateType: UpdateType;
}) => {
	await harvestRateLimit(updateType);
	const allClients = clientSchema.safeParse(await harvest.clients.list()).data
		?.clients;
	if (!allClients) throw new Error("clients did not match expected schema");

	const client = allClients.find((c) => clientNamesMatch(c.name, clientName));
	await harvestRateLimit(updateType);
	const allEntries = await harvest.timeEntries.list({
		client_id: client?.id,
	});
	const allMatchingEntries = allEntries.time_entries.filter((e) =>
		taskNamesMatch(e.notes, taskName),
	);

	const totalTime = allMatchingEntries.reduce((acc, e) => acc + e.hours, 0);

	return Math.round(totalTime * 100) / 100;
};
const hoursCache = new Cache<ReturnType<typeof runGetHoursByName>>({
	namespace: "hours",
	expireAfterMs: SECOND * 5,
});
export const getHoursByName: typeof runGetHoursByName = async (options) => {
	const cacheKey = JSON.stringify(options);
	const cached = hoursCache.get(cacheKey);
	if (cached) return cached;

	const result = runGetHoursByName(options);
	hoursCache.set(cacheKey, result);
	return await result;
};

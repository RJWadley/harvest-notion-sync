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

	logMessage("BULK", `Starting bulk update of ${total} entries`);

	const chunkSize = 10;
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
		logMessage("BULK", `Processed ${processed}/${total} cards`);
	}

	logMessage(
		"BULK",
		`Bulk update complete: ${processed}/${total} cards processed`,
	);
};

const threeMonthsAgo = () => {
	const date = new Date();
	date.setMonth(date.getMonth() - 3);
	return date.toISOString();
};

const runScheduledBulkUpdate = async () => {
	logMessage("BULK", "Running scheduled bulk update for last 3 months");

	await harvestRateLimit("bulk");
	const entriesRequest = await harvest.timeEntries.list({
		updated_since: threeMonthsAgo(),
		is_running: false,
	});

	const entries = entriesRequest.time_entries
		.map((e) => timeEntrySchema.safeParse(e))
		.filter((e) => e.success)
		.map((e) => e.data)
		.filter((c) => c.client.name !== "Underbelly")
		.filter((c) => c.client.name !== "Underbelly (Square)");

	logMessage("BULK", `Found ${entries.length} entries from last 3 months`);

	await processBulkUpdate(entries);

	// schedule next bulk update in 1 hour
	logMessage("BULK", "Scheduling next bulk update in 1 hour");
	setTimeout(runScheduledBulkUpdate, 60 * 60 * 1000);
};

const interval = 2 * 1000;
let lastCheck: string | undefined;

export const startWatching = () => {
	// kick off bulk update in background (don't await - priority system handles ordering)
	runScheduledBulkUpdate();
	// start realtime loop immediately
	lastCheck = new Date().toISOString();
	logMessage("LOOP", "Starting realtime watch loop");
	realtimeLoop();
};

const realtimeLoop = async () => {
	const waiting = new Promise((resolve) => setTimeout(resolve, interval));

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

	if (entries.length > 0) {
		logMessage("LOOP", "found", entries.length, "entries");
	}

	await Promise.all(
		entries.map(async (e) => {
			const card = await NotionCard.getOrCreate(
				{
					name: e.notes,
					project: e.client.name,
				},
				"realtime",
			);
			await card?.update("realtime");
		}),
	);

	await waiting;
	realtimeLoop();
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

import Harvest from "harvest";
import { z } from "zod";
import { clientNamesMatch, taskNamesMatch } from "./util";
import { NotionCard } from "./NotionCard";
import { harvestRateLimit } from "./limits";

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

const interval = 5 * 1000;
let lastCheck = "2024-05-01";
export const startWatching = async () => {
	const waiting =
		// wait at least 5 seconds between each request
		new Promise((resolve) => setTimeout(resolve, interval));

	const checkTime = lastCheck;
	lastCheck = new Date(new Date().getTime() - interval).toISOString();

	await harvestRateLimit();
	const updatedEntriesRequest = await harvest.timeEntries.list({
		updated_since: checkTime,
	});

	const entries = updatedEntriesRequest.time_entries
		.map((e) => timeEntrySchema.safeParse(e))
		.filter((e) => e.success)
		.map((e) => e.data);

	if (entries.length > 0)
		console.log("[UDPATE] found", entries.length, "entries");

	await Promise.all(
		entries.map(async (e) => {
			const card = await NotionCard.getOrCreate({
				name: e.notes,
				project: e.client.name,
			});
			await card?.update();
		}),
	);

	await waiting;
	startWatching();
};

const clientSchema = z.object({
	clients: z.object({ id: z.number(), name: z.string() }).array(),
});

export const getHoursByName = async ({
	taskName,
	clientName,
}: {
	clientName: string;
	taskName: string;
}) => {
	await harvestRateLimit();
	const allClients = clientSchema.safeParse(await harvest.clients.list()).data
		?.clients;
	if (!allClients) throw new Error("clients did not match expected schema");

	const client = allClients.find((c) => clientNamesMatch(c.name, clientName));
	await harvestRateLimit();
	const allEntries = await harvest.timeEntries.list({
		client_id: client?.id,
	});
	const allMatchingEntries = allEntries.time_entries.filter((e) =>
		taskNamesMatch(e.notes, taskName),
	);

	const totalTime = allMatchingEntries.reduce((acc, e) => acc + e.hours, 0);

	return Math.round(totalTime * 100) / 100;
};

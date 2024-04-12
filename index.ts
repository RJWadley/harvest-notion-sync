import Harvest from "harvest";
import { Client } from "@notionhq/client";

const accessToken = Bun.env.HARVEST_TOKEN;
const accountId = Bun.env.ACCOUNT_ID;
const clientDatabase = Bun.env.CLIENT_DATABASE;
const taskDatabase = Bun.env.TASK_DATABASE;
if (!accessToken || !accountId || !clientDatabase || !taskDatabase) {
	throw new Error("Missing credentials");
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

const notion = new Client({
	auth: process.env.NOTION_TOKEN,
});

const warn = (message: string, log: unknown) => {
	console.warn(message);
};

const clientNamesMatch = (nameA: string, nameB: string) => {
	return (
		nameA.toLowerCase().trim().startsWith(nameB.toLowerCase().trim()) ||
		nameB.toLowerCase().trim().startsWith(nameA.toLowerCase().trim())
	);
};

const interval = 5 * 1000;
let lastCheck = "2024-04-01";
let isFirstRun = true;
const check = async () => {
	const waiting: Promise<unknown>[] = [
		// wait at least 5 seconds between each request
		new Promise((resolve) => setTimeout(resolve, interval)),
	];
	const checkTime = lastCheck;
	lastCheck = new Date(new Date().getTime() - interval).toISOString();

	const updatedEntriesRequest = await harvest.timeEntries.list({
		updated_since: checkTime,
	});
	const updatedEntries = updatedEntriesRequest.time_entries.filter(
		/* filter out entries with the same client and notes */
		(entry, index, self) =>
			index ===
			self.findIndex((e) => {
				try {
					// @ts-expect-error - Harvest API is not fully typed
					return e.client?.id === entry.client?.id && e.notes === entry.notes;
				} catch {
					return false;
				}
			}),
	);

	console.log("Found", updatedEntries.length, "updated entries");
	if (updatedEntries.length === 0) {
		await Promise.all(waiting);
		check();
		return;
	}

	const clientRequest = await notion.databases.query({
		database_id: clientDatabase,
	});
	const notionClients = Object.entries(clientRequest.results).flatMap(
		([key, value]) => {
			try {
				const id = value.id;
				const name =
					// @ts-expect-error - Notion API is not typed
					value.properties?.["Project Name"]?.title?.at(0)?.plain_text;
				return [{ id, name }];
			} catch {
				return [];
			}
		},
	);

	/**
	 * for each update entry, fetch all previous entries that match the client and notes
	 */
	for (const entry of updatedEntries) {
		const allEntries = await harvest.timeEntries.list({
			// @ts-expect-error Harvest API is not fully typed
			client_id: entry.client?.id,
		});

		const allMatchingEntries = allEntries.time_entries.filter(
			(e) => e.notes === entry.notes,
		);

		const totalTime = allMatchingEntries.reduce((acc, e) => acc + e.hours, 0);

		/**
		 * find the client that matches the client name
		 */
		const harvestName = (entry.client as { name?: string })?.name ?? "";

		const matchingClients = notionClients.filter((client) =>
			clientNamesMatch(client?.name, harvestName),
		);

		/**
		 * fetch the relevant card from notion
		 */
		const matchingCardsRequest = await notion.databases.query({
			database_id: taskDatabase,
			filter: {
				or: matchingClients.map((client) => ({
					property: "Project",
					relation: {
						contains: client.id,
					},
				})),
			},
		});

		const matchingCards = matchingCardsRequest.results.filter((result) => {
			try {
				return (
					// @ts-expect-error - Notion API is not typed
					result.properties?.["Task name"]?.title
						?.at(0)
						.plain_text.toLowerCase()
						.trim() === entry.notes.toLowerCase().trim()
				);
			} catch {
				return false;
			}
		});

		const card = matchingCards.at(0);

		if (!card) {
			warn(
				`No matching cards found for ${harvestName} - ${entry.notes}`,
				entry,
			);
			continue;
		}

		if (matchingCards.length > 1) {
			warn(
				`Multiple matching cards found for ${harvestName} - ${entry.notes}`,
				entry,
			);
		}

		const roundedTime = Math.round(totalTime * 100) / 100;

		console.log(
			"Updating",
			`${harvestName} - ${entry.notes}`,
			"with",
			roundedTime,
			"hours",
		);

		/**
		 * in format 2:21pm, with no leading 0s
		 */
		const currentTime = new Date().toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "numeric",
			hour12: true,
		});

		/**
		 * in format YYYY-MM-DD
		 */
		const currentDate = new Date(
			// 24 hours ago
			new Date().getTime() - 24 * 60 * 60 * 1000,
		)
			.toISOString()
			.split("T")[0];

		/**
		 * update this card with the total time
		 */
		waiting.push(
			notion.pages.update({
				page_id: card.id,
				properties: {
					"Time Spent": {
						rich_text: isFirstRun
							? [
									{
										text: {
											content: `${roundedTime} Hours\t`,
										},
									},
									// current date, if desired
									// {
									// 	type: "equation",
									// 	equation: {
									// 		expression: `^{${currentDate?.split("-").join("-")}}`,
									// 	},
									// },
								]
							: [
									{
										text: {
											content: `${roundedTime} Hours\t`,
										},
									},
									// current time, if desired
									{
										type: "equation",
										equation: {
											expression: `^{${currentTime.toLowerCase()}}`,
										},
									},
								],
					},
				},
			}),
		);
	}

	await Promise.all(waiting);

	isFirstRun = false;
	check();
};

check();

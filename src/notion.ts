import { Client } from "@notionhq/client";
import { isFirstRun } from "./harvest";
import { notionRateLimit, notionWriteLimiter } from "./limits";
import Cache, { MINUTE } from "better-memory-cache";

const clientDatabase = Bun.env.CLIENT_DATABASE || "";
const taskDatabase = Bun.env.TASK_DATABASE || "";
const notionToken = Bun.env.NOTION_TOKEN || "";
if (!clientDatabase || !taskDatabase || !notionToken) {
	throw new Error("Missing credentials");
}

const notion = new Client({
	auth: notionToken,
});

/**
 * page queries
 */

const runGetPage = async (notionId: string) => {
	await notionRateLimit();
	return notion.pages.retrieve({
		page_id: notionId,
	});
};
const pageCache = new Cache<ReturnType<typeof runGetPage>>({
	namespace: "page",
	expireAfterMs: MINUTE,
});
export const getPage: typeof runGetPage = async (notionId) => {
	const cacheKey = notionId;
	const cached = pageCache.get(cacheKey);
	if (cached) return cached;

	const result = runGetPage(notionId);
	pageCache.set(cacheKey, result);
	return await result;
};

/**
 * database queries
 */

const runQueryDatabase = async ({
	type,
	filter,
}: {
	type: "client" | "task";
	filter?: { property: string; relation: { contains: string } };
}) => {
	await notionRateLimit();
	return notion.databases.query({
		database_id: type === "client" ? clientDatabase : taskDatabase,
		filter,
	});
};

const databaseCache = new Cache<ReturnType<typeof runQueryDatabase>>({
	namespace: "database",
	expireAfterMs: MINUTE,
});

export const queryDatabase: typeof runQueryDatabase = async (options) => {
	const cacheKey = JSON.stringify(options);
	const cached = databaseCache.get(cacheKey);
	if (cached) return cached;

	const result = runQueryDatabase(options);
	databaseCache.set(cacheKey, result);
	return await result;
};

/**
 * mutations
 */

const runUpdateHours = async (notionId: string, hours: number) => {
	await notionRateLimit();

	/**
	 * in format 2:21pm, with no leading 0s
	 */
	const currentTime = new Date().toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "numeric",
		hour12: true,
	});

	try {
		await notion.pages.update({
			page_id: notionId,
			properties: {
				"Time Spent": {
					rich_text: isFirstRun()
						? [
								{
									text: {
										content: `${hours} Hours Spent\t`,
									},
								},
							]
						: [
								{
									text: {
										content: `${hours} Hours Spent\t`,
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
		});
	} catch (e) {
		console.warn(`failed to update hours for ${notionId}`, e);
	}
};

export const updateHours: typeof runUpdateHours = async (notionId, hours) =>
	notionWriteLimiter(() => runUpdateHours(notionId, hours));

const runSendError = async (taskId: string) => {
	await notionRateLimit();

	try {
		await notion.pages.update({
			page_id: taskId,
			properties: {
				"Time Spent": {
					rich_text: [
						{
							text: {
								content: "Time Error: Multiple notion cards found.",
							},
						},
					],
				},
			},
		});
	} catch (e) {
		console.warn(`failed to send error for ${taskId}`, e);
	}
};

export const sendError: typeof runSendError = async (taskId) =>
	notionWriteLimiter(() => runSendError(taskId));

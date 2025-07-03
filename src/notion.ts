import { Client } from "@notionhq/client";
import { isFirstRun } from "./harvest";
import { notionRateLimit, notionWriteLimiter } from "./limits";
import Cache, { MINUTE } from "better-memory-cache";
import { warn, logMessage } from "./logging";

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
 * Retry wrapper for Notion API calls that handles timeout errors
 */
async function withRetry<T>(
	operation: () => Promise<T>,
	operationName: string,
	maxRetries = 3,
	baseDelay = 1000,
): Promise<T> {
	let lastError: any;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error: any) {
			lastError = error;

			// Check if this is a timeout error from the Notion client
			const isTimeoutError =
				error?.code === "notionhq_client_request_timeout" ||
				error?.name === "RequestTimeoutError" ||
				error?.message?.includes("timed out");

			if (!isTimeoutError) {
				// If it's not a timeout error, don't retry - rethrow immediately
				throw error;
			}

			if (attempt === maxRetries) {
				// Last attempt failed, log and rethrow
				warn(
					`${operationName} failed after ${maxRetries} attempts due to timeouts`,
					error,
				);
				throw error;
			}

			// Calculate delay with exponential backoff
			const delay = baseDelay * Math.pow(2, attempt - 1);
			logMessage(
				`${operationName} attempt ${attempt} timed out, retrying in ${delay}ms...`,
			);

			// Wait before retrying
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}

/**
 * page queries
 */

const runGetPage = async (notionId: string) => {
	await notionRateLimit();
	return withRetry(
		() => notion.pages.retrieve({ page_id: notionId }),
		`getPage(${notionId})`,
	);
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
	filter?: Parameters<typeof notion.databases.query>[0]["filter"];
}) => {
	await notionRateLimit();
	return withRetry(
		() =>
			notion.databases.query({
				database_id: type === "client" ? clientDatabase : taskDatabase,
				filter,
			}),
		`queryDatabase(${type})`,
	);
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

	const roundedHours = Math.round(hours * 100) / 100;

	try {
		const result = await withRetry(
			() =>
				notion.pages.update({
					page_id: notionId,
					properties: {
						"Time Spent": {
							rich_text: isFirstRun()
								? [
										{
											text: {
												content: `${roundedHours} Hours Spent\t`,
											},
										},
									]
								: [
										{
											text: {
												content: `${roundedHours} Hours Spent\t`,
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
			`updateHours(${notionId})`,
		);
		pageCache.set(notionId, Promise.resolve(result));
		return result;
	} catch (e) {
		warn(`failed to update hours for ${notionId}`, e);
		throw e; // Re-throw to maintain error handling behavior
	}
};

export const updateHours: typeof runUpdateHours = async (notionId, hours) =>
	notionWriteLimiter(() => runUpdateHours(notionId, hours));

const runSendError = async (taskId: string) => {
	await notionRateLimit();

	try {
		await withRetry(
			() =>
				notion.pages.update({
					page_id: taskId,
					properties: {
						"Time Spent": {
							rich_text: [
								{
									text: {
										content:
											"Time Error: Multiple notion cards share the same name",
									},
								},
							],
						},
					},
				}),
			`sendError(${taskId})`,
		);
	} catch (e) {
		warn(`failed to send error for ${taskId}`, e);
		throw e; // Re-throw to maintain error handling behavior
	}
};

export const sendError: typeof runSendError = async (taskId) =>
	notionWriteLimiter(() => runSendError(taskId));

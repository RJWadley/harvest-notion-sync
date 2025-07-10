import type { Client } from "@notionhq/client";
import Cache, { MINUTE } from "better-memory-cache";
import type { UpdateType } from "./limits";
import { notionRateLimit, notionWriteLimit } from "./limits";
import { logMessage, warn } from "./logging";

const clientDatabase = Bun.env.CLIENT_DATABASE || "";
const taskDatabase = Bun.env.TASK_DATABASE || "";

if (!clientDatabase || !taskDatabase) {
	throw new Error("Missing CLIENT_DATABASE or TASK_DATABASE credentials");
}

/**
 * Retry wrapper for Notion API calls that handles timeout errors
 */
async function withRetry<T>(
	operation: () => Promise<T>,
	operationName: string,
	updateType: UpdateType,
	maxRetries = 10,
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

			if (attempt >= maxRetries) {
				// Last attempt failed, log and rethrow
				warn(
					`${operationName} failed after ${maxRetries} attempts due to timeouts`,
					error,
					updateType,
				);
				throw error;
			}

			logMessage(
				`${operationName} attempt ${attempt} timed out, retrying in ${baseDelay * attempt}ms...`,
			);

			await new Promise((resolve) => setTimeout(resolve, baseDelay * attempt));
		}
	}

	throw lastError;
}

/**
 * page queries
 */

const runGetPage = async (notionId: string, updateType: UpdateType) => {
	const notion = await notionRateLimit(updateType);
	return withRetry(
		() => notion.pages.retrieve({ page_id: notionId }),
		`getPage(${notionId})`,
		updateType,
	);
};
const pageCache = new Cache<ReturnType<typeof runGetPage>>({
	namespace: "page",
	expireAfterMs: MINUTE,
});
export const getPage: typeof runGetPage = async (notionId, updateType) => {
	const cacheKey = notionId;
	const cached = pageCache.get(cacheKey);
	if (cached) return cached;

	const result = runGetPage(notionId, updateType);
	pageCache.set(cacheKey, result);
	return await result;
};

/**
 * database queries
 */

const runQueryDatabase = async ({
	type,
	filter,
	updateType,
}: {
	type: "client" | "task";
	filter?: Parameters<typeof Client.prototype.databases.query>[0]["filter"];
	updateType: UpdateType;
}) => {
	const notion = await notionRateLimit(updateType);
	return withRetry(
		() =>
			notion.databases.query({
				database_id: type === "client" ? clientDatabase : taskDatabase,
				filter,
			}),
		`queryDatabase(${type})`,
		updateType,
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

const runUpdateHours = async (
	notionId: string,
	hours: number,
	updateType: UpdateType,
) => {
	/**
	 * in format 2:21pm, with no leading 0s
	 */
	const currentTime = new Date().toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "numeric",
		hour12: true,
	});

	const roundedHours = Math.round(hours * 100) / 100;
	const notion = await notionRateLimit(updateType);

	try {
		const result = await withRetry(
			() =>
				notion.pages.update({
					page_id: notionId,
					properties: {
						"Time Spent": {
							rich_text:
								updateType === "bulk"
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
			updateType,
		);
		pageCache.set(notionId, Promise.resolve(result));
		return result;
	} catch (e) {
		warn(`failed to update hours for ${notionId}`, e, updateType);
		throw e; // Re-throw to maintain error handling behavior
	}
};

export const updateHours: typeof runUpdateHours = async (
	notionId,
	hours,
	updateType,
) =>
	await notionWriteLimit(
		() => runUpdateHours(notionId, hours, updateType),
		updateType,
	);

const runSendError = async (taskId: string, updateType: UpdateType) => {
	const notion = await notionRateLimit("realtime");

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
			updateType,
		);
	} catch (e) {
		warn(`failed to send error for ${taskId}`, e, updateType);
		throw e; // Re-throw to maintain error handling behavior
	}
};

export const sendError: typeof runSendError = async (taskId, updateType) =>
	notionWriteLimit(() => runSendError(taskId, updateType), updateType);

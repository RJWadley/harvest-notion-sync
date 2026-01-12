import type { Client } from "@notionhq/client";
import Cache, { MINUTE } from "better-memory-cache";
import { sendHeartbeat } from "./heartbeat";
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
				"API",
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
 *
 * in notion sdk v5, databases are containers that hold data sources.
 * to query, we need to first retrieve the database to get its data_source_id,
 * then query the data source.
 */

// cache data source IDs so we don't have to retrieve the database every time
const dataSourceIdCache = new Cache<Promise<string>>({
	namespace: "dataSourceId",
	expireAfterMs: MINUTE * 30,
});

const getDataSourceId = async (
	databaseId: string,
	updateType: UpdateType,
): Promise<string> => {
	const cached = dataSourceIdCache.get(databaseId);
	if (cached) return cached;

	const result = (async () => {
		const notion = await notionRateLimit(updateType);
		const dbInfo = await withRetry(
			() => notion.databases.retrieve({ database_id: databaseId }),
			`getDataSourceId(${databaseId})`,
			updateType,
		);

		if (!("data_sources" in dbInfo) || dbInfo.data_sources.length === 0) {
			throw new Error(`Database ${databaseId} has no data sources`);
		}

		const firstDataSource = dbInfo.data_sources[0];
		if (!firstDataSource) {
			throw new Error(`Database ${databaseId} has no data sources`);
		}

		return firstDataSource.id;
	})();

	dataSourceIdCache.set(databaseId, result);
	return result;
};

const runQueryDatabase = async ({
	type,
	filter,
	updateType,
}: {
	type: "client" | "task";
	filter?: Parameters<typeof Client.prototype.dataSources.query>[0]["filter"];
	updateType: UpdateType;
}) => {
	const databaseId = type === "client" ? clientDatabase : taskDatabase;
	const dataSourceId = await getDataSourceId(databaseId, updateType);

	const notion = await notionRateLimit(updateType);
	return withRetry(
		() =>
			notion.dataSources.query({
				data_source_id: dataSourceId,
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
		sendHeartbeat();
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

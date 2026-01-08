import Harvest from "harvest";
import { harvestRateLimit, type UpdateType } from "./limits";
import { logMessage, warn } from "./logging";

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

const TIMEOUT_MS = 30_000;

/**
 * wraps a promise with a timeout
 */
const withTimeout = <T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> => {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(`${label} timed out after ${ms}ms`)),
				ms,
			),
		),
	]);
};

/**
 * retry wrapper for harvest api calls that handles timeout errors
 */
async function withRetry<T>(
	operation: () => Promise<T>,
	operationName: string,
	updateType: UpdateType,
	maxRetries = 10,
	baseDelay = 1000,
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await withTimeout(operation(), TIMEOUT_MS, operationName);
		} catch (error: unknown) {
			lastError = error;

			const isTimeoutError =
				error instanceof Error && error.message.includes("timed out");

			if (!isTimeoutError) {
				// not a timeout error, don't retry
				throw error;
			}

			if (attempt >= maxRetries) {
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
 * list time entries with optional filters
 */
export const listTimeEntries = async (
	options: {
		updated_since?: string;
		is_running?: boolean;
		client_id?: number;
	},
	updateType: UpdateType,
) => {
	await harvestRateLimit(updateType);
	return withRetry(
		() => harvest.timeEntries.list(options),
		`listTimeEntries(${JSON.stringify(options)})`,
		updateType,
	);
};

/**
 * list all clients
 */
export const listClients = async (updateType: UpdateType) => {
	await harvestRateLimit(updateType);
	return withRetry(() => harvest.clients.list(), "listClients()", updateType);
};

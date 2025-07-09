import { asyncQueue, queue } from "@tanstack/pacer";
import type { UpdateType } from "./harvest";

// Priority levels - higher numbers get processed first
const PRIORITY = {
	realtime: 10,
	bulk: 1,
} as const;

// Rate limiting operation wrapper
interface RateLimitTask {
	resolve: () => void;
	priority: number;
}

interface WriteOperation {
	operation: () => Promise<any>;
	priority: number;
}

// Notion read rate limiter - 3 operations per second
const notionReadQueue = queue<RateLimitTask>(
	async (task) => {
		task.resolve();
	},
	{
		wait: 1000 / 3, // ~333ms between operations
		getPriority: (task) => task.priority,
	},
);

// Notion write queue - concurrency 1 (only one write at a time)
const notionWriteQueue = asyncQueue<WriteOperation>(
	async ({ operation }) => {
		return await operation();
	},
	{
		concurrency: 1,
		getPriority: (task) => task.priority,
	},
);

// Harvest rate limiter - 100 operations per 15 seconds
const harvestReadQueue = queue<RateLimitTask>(
	async (task) => {
		task.resolve();
	},
	{
		wait: 15_000 / 100, // 150ms between operations
		getPriority: (task) => task.priority,
	},
);

// Exported functions
export const notionRateLimit = (updateType: UpdateType): Promise<void> => {
	return new Promise<void>((resolve) => {
		const priority = PRIORITY[updateType];
		notionReadQueue({
			resolve,
			priority,
		});
	});
};

export const notionWriteLimit = <T>(
	operation: () => Promise<T>,
	updateType: UpdateType,
): Promise<T> => {
	return new Promise<T>((resolve) => {
		notionWriteQueue({
			operation: async () => {
				const result = await operation();
				resolve(result);
			},
			priority: PRIORITY[updateType],
		});
	});
};

export const harvestRateLimit = (updateType: UpdateType): Promise<void> => {
	return new Promise<void>((resolve) => {
		const priority = PRIORITY[updateType];
		harvestReadQueue({
			resolve,
			priority,
		});
	});
};

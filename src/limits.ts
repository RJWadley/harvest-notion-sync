import { Client } from "@notionhq/client";
import { asyncQueue, queue } from "@tanstack/pacer";

// Initialize Notion clients
const notionTokenA = Bun.env.NOTION_TOKEN_A || "";
const notionTokenB = Bun.env.NOTION_TOKEN_B || "";
const notionTokenC = Bun.env.NOTION_TOKEN_C || "";
const notionTokenD = Bun.env.NOTION_TOKEN_D || "";

if (!notionTokenA || !notionTokenB || !notionTokenC || !notionTokenD) {
	throw new Error("Missing NOTION_TOKEN_A through NOTION_TOKEN_D credentials");
}

const notionClients = [
	new Client({ auth: notionTokenA }),
	new Client({ auth: notionTokenB }),
	new Client({ auth: notionTokenC }),
	new Client({ auth: notionTokenD }),
];

// Priority levels - higher numbers get processed first
const PRIORITY = {
	realtime: 10,
	bulk: 2,
	background: 1,
} as const;
export type UpdateType = keyof typeof PRIORITY;

// Rate limiting operation wrapper
interface NotionRateLimitTask {
	resolve: (client: Client) => void;
	priority: number;
}

// Rate limiting task for harvest (returns void, not client)
interface HarvestRateLimitTask {
	resolve: () => void;
	priority: number;
}

interface WriteOperation {
	operation: () => Promise<any>;
	priority: number;
}

// Notion read rate limiters - 4 clients, each with 3 operations per second
const notionReadQueues = notionClients.map((client) =>
	queue<NotionRateLimitTask>(
		async (task) => {
			task.resolve(client);
		},
		{
			wait: 1000 / 3, // ~333ms between operations
			getPriority: (task) => task.priority,
		},
	),
);

let queueIndex = 0;
const getNotionReadQueue = () => {
	const queue = notionReadQueues[queueIndex];
	queueIndex = (queueIndex + 1) % notionReadQueues.length;
	if (!queue) throw new Error("Queue not found");
	return queue;
};

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
const harvestReadQueue = queue<HarvestRateLimitTask>(
	async (task) => {
		task.resolve();
	},
	{
		wait: 15_000 / 100, // 150ms between operations
		getPriority: (task) => task.priority,
	},
);

// Exported functions
export const notionRateLimit = (updateType: UpdateType): Promise<Client> => {
	return new Promise<Client>((resolve) => {
		const priority = PRIORITY[updateType];
		const queue = getNotionReadQueue();
		if (!queue) throw new Error("Queue not found");
		queue({
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

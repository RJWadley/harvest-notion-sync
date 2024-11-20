import { sleep } from "bun";
import { pRateLimit } from "p-ratelimit";

const notionLimiter = pRateLimit({
	interval: 1200,
	rate: 3, // 3 API calls per interval
});

const harvestLimiter = pRateLimit({
	interval: 15_000,
	rate: 100,
});

export const notionRateLimit = async () => {
	return await notionLimiter(() => sleep(0));
};

export const harvestRateLimit = async () => {
	return await harvestLimiter(() => sleep(0));
};

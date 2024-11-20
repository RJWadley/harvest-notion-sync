import Cache, { MINUTE } from "better-memory-cache";

const cache = new Cache<true>({
	namespace: "logging",
	expireAfterMs: MINUTE,
});

export const logMessage = (...messages: (string | number)[]) => {
	const sent = cache.get(messages.join(" "));
	if (sent) return;

	cache.set(messages.join(" "), true);
	console.log(...messages);
};

import Cache, { HOUR, SECOND } from "better-memory-cache";
import { isFirstRun } from "./harvest";
import { SlackAPIClient } from "slack-web-api-client";

const slackToken = Bun.env.SLACK_BOT_TOKEN;
if (!slackToken) {
	throw new Error("Missing credentials");
}

const client = new SlackAPIClient(slackToken);
const channel = "C074ZFE9WNR";

const cache = new Cache<true>({
	namespace: "logging",
	expireAfterMs: SECOND * 5,
});

export const logMessage = (...messages: (string | number)[]) => {
	const sent = cache.get(messages.join(" "));
	if (sent) return;

	cache.set(messages.join(" "), true);
	console.log(...messages);
};

const warnCoolDown = new Map<string, number>();
export const warn = async (message: string, log: unknown) => {
	console.warn(message);
	if (!isFirstRun()) {
		const coolDownUntil = warnCoolDown.get(message) ?? 0;
		if (coolDownUntil > Date.now()) {
			return;
		}
		warnCoolDown.set(message, Date.now() + 5 * HOUR);

		const slackMessage = await client.chat.postMessage({
			channel,
			text: message,
		});

		if (log)
			await client.chat.postMessage({
				channel,
				text: `debug details:\n\n${JSON.stringify(log)}`,
				thread_ts: slackMessage.ts,
			});
	}
};

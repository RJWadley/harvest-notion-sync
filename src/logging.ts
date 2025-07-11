import Cache, { HOUR, SECOND } from "better-memory-cache";
import logger from "node-color-log";
import { SlackAPIClient } from "slack-web-api-client";
import type { UpdateType } from "./limits";

logger.setDate(() => new Date().toLocaleTimeString());

type LogType = "LOOP" | "BULK" | "SKIP" | "WRITE" | "AWAIT" | "START" | "NONE";

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

export const logMessage = (
	logType: LogType,
	...messages: (string | number)[]
) => {
	const sent = cache.get([logType, ...messages].join(" "));
	if (sent) return;
	cache.set([logType, ...messages].join(" "), true);

	if (logType === "NONE") {
		logger.log(...messages);
		return;
	}

	let logChain = logger.bold().append(`[${logType}] `).reset();
	switch (logType) {
		case "LOOP":
			logChain = logger.color("blue").bold().append(`[${logType}] `).reset();
			break;
		case "BULK":
			logChain = logger.color("magenta").bold().append(`[${logType}] `).reset();
			break;
		case "SKIP":
			logChain = logger.color("yellow").bold().append(`[${logType}] `).reset();
			break;
		case "WRITE":
			logChain = logger.color("green").bold().append(`[${logType}] `).reset();
			break;
		case "AWAIT":
		case "START":
			logChain = logger.color("cyan").bold().append(`[${logType}] `).reset();
			break;
	}
	logChain.log(...messages);
};

const warnCoolDown = new Map<string, number>();
export const warn = async (
	message: string,
	log: unknown,
	updateType: UpdateType,
) => {
	if (updateType === "realtime") {
		logger.warn(message);
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

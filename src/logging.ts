import { Mutex } from "async-mutex";
import Cache, { HOUR, SECOND } from "better-memory-cache";
import logger from "node-color-log";
import { SlackAPIClient } from "slack-web-api-client";
import type { UpdateType } from "./limits";

logger.setDate(() => new Date().toLocaleTimeString());

type LogType = "LOOP" | "BULK" | "SKIP" | "WRITE" | "API";

const logMutex = new Mutex();

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

export const logMessage = async (
	logType: LogType,
	...messages: (string | number)[]
) => {
	await logMutex.runExclusive(() => {
		const sent = cache.get([logType, ...messages].join(" "));
		if (sent) return;
		cache.set([logType, ...messages].join(" "), true);

		logger.setLogStream(process.stdout);

		if (logType === "API") {
			logger.log(...messages);
			return;
		}

		type Color = "blue" | "magenta" | "yellow" | "green" | "cyan" | "white";
		const colorMap: Record<LogType, Color> = {
			LOOP: "blue",
			BULK: "magenta",
			SKIP: "yellow",
			WRITE: "green",
			API: "white",
		};

		logger
			.color(colorMap[logType] ?? "white")
			.bold()
			.append(`[${logType}] `)
			.reset()
			.log(...messages);
	});
};

const warnCoolDown = new Map<string, number>();
export const warn = async (
	message: string,
	log: unknown,
	updateType: UpdateType,
) => {
	await logMutex.runExclusive(async () => {
		if (updateType === "realtime") {
			logger.setLogStream(process.stderr);
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
	});
};

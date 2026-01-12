import { logMessage, warn } from "./logging";

// how long without a heartbeat before we consider the app stuck
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds

let lastHeartbeat = Date.now();
let checkIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * call this whenever we successfully post a time update to notion,
 * or when the main loop completes an iteration (to prove it's still running)
 */
export function sendHeartbeat() {
	lastHeartbeat = Date.now();
}

/**
 * starts the heartbeat checker. if no heartbeat is received within the timeout,
 * exits with code 1 so the server can restart the process.
 */
export function startHeartbeatChecker() {
	if (checkIntervalId) {
		clearInterval(checkIntervalId);
	}

	logMessage("HEARTBEAT", `started (timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s)`);

	checkIntervalId = setInterval(() => {
		const timeSinceLastHeartbeat = Date.now() - lastHeartbeat;

		if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
			const minutes =
				Math.round((timeSinceLastHeartbeat / 1000 / 60) * 10) / 10;
			warn(
				`no heartbeat for ${minutes} minutes, exiting to allow restart`,
				undefined,
				"realtime",
			);
			process.exit(1);
		}
	}, CHECK_INTERVAL_MS);
}

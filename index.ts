import logger from "node-color-log";
import { startWatching } from "./src/harvest";
import { startHeartbeatChecker } from "./src/heartbeat";

logger.setDate(() => new Date().toLocaleTimeString());
logger.info("starting up");

startHeartbeatChecker();
startWatching();

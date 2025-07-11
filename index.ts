import logger from "node-color-log";
import { startWatching } from "./src/harvest";

logger.setDate(() => new Date().toLocaleTimeString());
logger.info("starting up");

startWatching();

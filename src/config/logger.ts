import pino from "pino";
import { env } from "./env.js";

const transport =
  env.NODE_ENV === "development"
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard"
        }
      }
    : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  transport
});

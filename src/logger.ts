import winston, { format } from "winston";

const logLikeFormat: Parameters<typeof format.combine>[number] = {
  transform(info) {
    const { timestamp, message } = info;
    const level = info.level;
    const args = info[Symbol.for("splat") as unknown as string];
    info[Symbol.for("message") as unknown as string] =
      `${timestamp} ${level}: ${message as string}${
        Array.isArray(args) && args.length ? ` ${args.join(" ")}` : ""
      }`;
    return info;
  },
};

export const logger = winston.createLogger({
  format: format.combine(
    winston.format.colorize({ colors: winston.config.npm.colors }),
    format.timestamp(),
    logLikeFormat,
  ),
  transports: [new winston.transports.Console()],
});

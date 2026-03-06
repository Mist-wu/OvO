import fs from "node:fs";
import path from "node:path";
import util from "node:util";

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    if (normalized in LEVEL_ORDER) return normalized as LogLevel;
    return fallback;
}

type LogTransport = (level: LogLevel, timestamp: string, args: unknown[]) => void;

const consoleTransport: LogTransport = (level, timestamp, args) => {
    const prefix = `${timestamp} [${level.toUpperCase()}]`;
    switch (level) {
        case "debug":
            console.debug(prefix, ...args);
            break;
        case "info":
            console.info(prefix, ...args);
            break;
        case "warn":
            console.warn(prefix, ...args);
            break;
        case "error":
            console.error(prefix, ...args);
            break;
    }
};

function formatLogArg(value: unknown): string {
    if (value instanceof Error) {
        return value.stack || value.message;
    }
    if (typeof value === "string") {
        return value;
    }
    return util.inspect(value, {
        depth: 5,
        breakLength: Infinity,
        compact: true,
    });
}

function formatLogLine(level: LogLevel, timestamp: string, args: unknown[]): string {
    const payload = args.map((item) => formatLogArg(item)).join(" ");
    return `${timestamp} [${level.toUpperCase()}] ${payload}\n`;
}

const BEIJING_TIMEZONE = "Asia/Shanghai";
const beijingDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: BEIJING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
});

export function formatBeijingTimeTag(date: Date = new Date()): string {
    const parts = beijingDateTimeFormatter
        .formatToParts(date)
        .reduce<Record<string, string>>((accumulator, part) => {
            if (part.type !== "literal") {
                accumulator[part.type] = part.value;
            }
            return accumulator;
        }, {});

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}`;
}

const startupTimeTag = formatBeijingTimeTag();
const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE_PATH = path.join(LOG_DIR, `${startupTimeTag}.log`);

const fileTransport: LogTransport = (() => {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        return (level, timestamp, args) => {
            const line = formatLogLine(level, timestamp, args);
            try {
                fs.appendFileSync(LOG_FILE_PATH, line, "utf8");
            } catch (error) {
                console.error("写入日志文件失败:", error);
            }
        };
    } catch (error) {
        console.error("初始化日志目录失败，已降级为仅控制台输出:", error);
        return () => undefined;
    }
})();

const defaultTransport: LogTransport = (level, timestamp, args) => {
    consoleTransport(level, timestamp, args);
    fileTransport(level, timestamp, args);
};

class Logger {
    private minLevel: number;
    private transport: LogTransport;

    constructor(level: LogLevel = "info", transport: LogTransport = defaultTransport) {
        this.minLevel = LEVEL_ORDER[level];
        this.transport = transport;
    }

    setLevel(level: LogLevel): void {
        this.minLevel = LEVEL_ORDER[level];
    }

    getLevel(): LogLevel {
        for (const [key, value] of Object.entries(LEVEL_ORDER)) {
            if (value === this.minLevel) return key as LogLevel;
        }
        return "info";
    }

    setTransport(transport: LogTransport): void {
        this.transport = transport;
    }

    resetTransport(): void {
        this.transport = defaultTransport;
    }

    debug(...args: unknown[]): void {
        this.emit("debug", args);
    }

    info(...args: unknown[]): void {
        this.emit("info", args);
    }

    warn(...args: unknown[]): void {
        this.emit("warn", args);
    }

    error(...args: unknown[]): void {
        this.emit("error", args);
    }

    emitRaw(level: LogLevel, ...args: unknown[]): void {
        if (level === "silent") return;
        const timestamp = new Date().toISOString();
        this.transport(level, timestamp, args);
    }

    private emit(level: LogLevel, args: unknown[]): void {
        if (LEVEL_ORDER[level] < this.minLevel) return;
        const timestamp = new Date().toISOString();
        this.transport(level, timestamp, args);
    }
}

export const logger = new Logger(
    parseLogLevel(process.env.LOG_LEVEL, "info"),
);

export function getLogFilePath(): string {
    return LOG_FILE_PATH;
}

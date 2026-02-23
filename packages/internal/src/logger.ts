import type { ConsolaInstance } from 'consola';
import process from 'node:process';
import { consola } from 'consola';

const registeredLoggers = new Set<ConsolaInstance>();

export function setLoggerLevel(level: number): void {
	for (const logger of registeredLoggers) {
		logger.level = level;
	}
}

export function createLogger(name: string): ConsolaInstance {
	const logger: ConsolaInstance = consola.withTag(name);

	// Apply LOG_LEVEL environment variable if set
	if (process.env.LOG_LEVEL != null) {
		const level = Number.parseInt(process.env.LOG_LEVEL, 10);
		if (!Number.isNaN(level)) {
			logger.level = level;
		}
	}

	registeredLoggers.add(logger);
	return logger;
}

// eslint-disable-next-line no-console
export const log = console.log;

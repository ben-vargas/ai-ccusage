import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { groupBy } from 'es-toolkit';
import { calculateCostForEntry } from './cost-utils.ts';

const DATE_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function resolveTimeZone(timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	}

	try {
		Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return timezone;
	} catch {
		return 'UTC';
	}
}

function getDateKeyFormatter(timezone?: string): Intl.DateTimeFormat {
	const resolvedTimeZone = resolveTimeZone(timezone);
	const cached = DATE_KEY_FORMATTER_CACHE.get(resolvedTimeZone);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: resolvedTimeZone,
	});

	DATE_KEY_FORMATTER_CACHE.set(resolvedTimeZone, formatter);
	return formatter;
}

function toDateKey(timestamp: Date, timezone?: string): string {
	return getDateKeyFormatter(timezone).format(timestamp);
}

export type DailyReportRow = {
	date: string; // YYYY-MM-DD
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
};

export type DailyReportOptions = {
	pricingFetcher: LiteLLMPricingFetcher;
	timezone?: string;
};

export async function buildDailyReport(
	entries: LoadedUsageEntry[],
	options: DailyReportOptions,
): Promise<DailyReportRow[]> {
	const entriesByDate = groupBy(entries, (entry) => toDateKey(entry.timestamp, options.timezone));

	const dailyData: DailyReportRow[] = [];

	for (const [date, dayEntries] of Object.entries(entriesByDate)) {
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreationTokens = 0;
		let cacheReadTokens = 0;
		let totalCost = 0;
		const modelsSet = new Set<string>();

		for (const entry of dayEntries) {
			inputTokens += entry.usage.inputTokens;
			outputTokens += entry.usage.outputTokens;
			cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			cacheReadTokens += entry.usage.cacheReadInputTokens;
			totalCost += await calculateCostForEntry(entry, options.pricingFetcher);
			modelsSet.add(entry.model);
		}

		const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

		dailyData.push({
			date,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
			totalTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
		});
	}

	dailyData.sort((a, b) => a.date.localeCompare(b.date));

	return dailyData;
}

if (import.meta.vitest != null) {
	describe('buildDailyReport', () => {
		it('groups by timezone-aware day key', async () => {
			const entries: LoadedUsageEntry[] = [
				{
					timestamp: new Date('2026-02-22T23:30:00.000Z'),
					sessionID: 's1',
					usage: {
						inputTokens: 1,
						outputTokens: 2,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					model: 'gpt-5.3-codex',
					costUSD: 0.1,
				},
				{
					timestamp: new Date('2026-02-23T00:30:00.000Z'),
					sessionID: 's1',
					usage: {
						inputTokens: 3,
						outputTokens: 4,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					model: 'gpt-5.3-codex',
					costUSD: 0.2,
				},
			];

			const rows = await buildDailyReport(entries, {
				pricingFetcher: {} as LiteLLMPricingFetcher,
				timezone: 'America/Los_Angeles',
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]?.date).toBe('2026-02-22');
			expect(rows[0]?.totalTokens).toBe(10);
			expect(rows[0]?.totalCost).toBeCloseTo(0.3, 10);
		});
	});
}

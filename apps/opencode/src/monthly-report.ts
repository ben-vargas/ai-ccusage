import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { groupBy } from 'es-toolkit';
import { calculateCostForEntry } from './cost-utils.ts';

const MONTH_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

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

function getMonthKeyFormatter(timezone?: string): Intl.DateTimeFormat {
	const resolvedTimeZone = resolveTimeZone(timezone);
	const cached = MONTH_KEY_FORMATTER_CACHE.get(resolvedTimeZone);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		timeZone: resolvedTimeZone,
	});

	MONTH_KEY_FORMATTER_CACHE.set(resolvedTimeZone, formatter);
	return formatter;
}

function toMonthKey(timestamp: Date, timezone?: string): string {
	const [year, month] = getMonthKeyFormatter(timezone).format(timestamp).split('-');
	return `${year}-${month}`;
}

export type MonthlyReportRow = {
	month: string; // YYYY-MM
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
};

export type MonthlyReportOptions = {
	pricingFetcher: LiteLLMPricingFetcher;
	timezone?: string;
};

export async function buildMonthlyReport(
	entries: LoadedUsageEntry[],
	options: MonthlyReportOptions,
): Promise<MonthlyReportRow[]> {
	const entriesByMonth = groupBy(entries, (entry) => toMonthKey(entry.timestamp, options.timezone));

	const monthlyData: MonthlyReportRow[] = [];

	for (const [month, monthEntries] of Object.entries(entriesByMonth)) {
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreationTokens = 0;
		let cacheReadTokens = 0;
		let totalCost = 0;
		const modelsSet = new Set<string>();

		for (const entry of monthEntries) {
			inputTokens += entry.usage.inputTokens;
			outputTokens += entry.usage.outputTokens;
			cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			cacheReadTokens += entry.usage.cacheReadInputTokens;
			totalCost += await calculateCostForEntry(entry, options.pricingFetcher);
			modelsSet.add(entry.model);
		}

		const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

		monthlyData.push({
			month,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
			totalTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
		});
	}

	monthlyData.sort((a, b) => a.month.localeCompare(b.month));

	return monthlyData;
}

if (import.meta.vitest != null) {
	describe('buildMonthlyReport', () => {
		it('groups by timezone-aware month key', async () => {
			const entries: LoadedUsageEntry[] = [
				{
					timestamp: new Date('2026-03-01T00:30:00.000Z'),
					sessionID: 's1',
					usage: {
						inputTokens: 10,
						outputTokens: 20,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					model: 'gpt-5.3-codex',
					costUSD: 1,
				},
			];

			const rows = await buildMonthlyReport(entries, {
				pricingFetcher: {} as LiteLLMPricingFetcher,
				timezone: 'America/Los_Angeles',
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]?.month).toBe('2026-02');
			expect(rows[0]?.totalTokens).toBe(30);
		});
	});
}

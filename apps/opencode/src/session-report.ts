import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedSessionMetadata, LoadedUsageEntry } from './data-loader.ts';
import { groupBy } from 'es-toolkit';
import { calculateCostForEntry } from './cost-utils.ts';

export type SessionReportRow = {
	sessionID: string;
	sessionTitle: string;
	parentID: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
	lastActivity: string; // ISO timestamp
};

export type SessionReportOptions = {
	pricingFetcher: LiteLLMPricingFetcher;
	sessionMetadata?: Map<string, LoadedSessionMetadata>;
};

export async function buildSessionReport(
	entries: LoadedUsageEntry[],
	options: SessionReportOptions,
): Promise<SessionReportRow[]> {
	const entriesBySession = groupBy(entries, (entry) => entry.sessionID);
	const sessionMetadata = options.sessionMetadata ?? new Map<string, LoadedSessionMetadata>();

	const sessionData: SessionReportRow[] = [];

	for (const [sessionID, sessionEntries] of Object.entries(entriesBySession)) {
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreationTokens = 0;
		let cacheReadTokens = 0;
		let totalCost = 0;
		const modelsSet = new Set<string>();
		let lastActivity = sessionEntries[0]!.timestamp;

		for (const entry of sessionEntries) {
			inputTokens += entry.usage.inputTokens;
			outputTokens += entry.usage.outputTokens;
			cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			cacheReadTokens += entry.usage.cacheReadInputTokens;
			totalCost += await calculateCostForEntry(entry, options.pricingFetcher);
			modelsSet.add(entry.model);

			if (entry.timestamp > lastActivity) {
				lastActivity = entry.timestamp;
			}
		}

		const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
		const metadata = sessionMetadata.get(sessionID);

		sessionData.push({
			sessionID,
			sessionTitle: metadata?.title ?? sessionID,
			parentID: metadata?.parentID ?? null,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
			totalTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
			lastActivity: lastActivity.toISOString(),
		});
	}

	sessionData.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));

	return sessionData;
}

if (import.meta.vitest != null) {
	describe('buildSessionReport', () => {
		it('aggregates by session and applies metadata', async () => {
			const entries: LoadedUsageEntry[] = [
				{
					timestamp: new Date('2026-02-20T00:00:00.000Z'),
					sessionID: 's1',
					usage: {
						inputTokens: 10,
						outputTokens: 5,
						cacheCreationInputTokens: 2,
						cacheReadInputTokens: 1,
					},
					model: 'gpt-5.3-codex',
					costUSD: 0.5,
				},
				{
					timestamp: new Date('2026-02-20T01:00:00.000Z'),
					sessionID: 's1',
					usage: {
						inputTokens: 3,
						outputTokens: 2,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					model: 'gpt-5.3-codex',
					costUSD: 0.25,
				},
			];

			const rows = await buildSessionReport(entries, {
				pricingFetcher: {} as LiteLLMPricingFetcher,
				sessionMetadata: new Map([
					[
						's1',
						{
							id: 's1',
							parentID: null,
							title: 'Session One',
							projectID: 'p1',
							directory: '/tmp/project',
						},
					],
				]),
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]?.sessionTitle).toBe('Session One');
			expect(rows[0]?.totalTokens).toBe(23);
			expect(rows[0]?.totalCost).toBeCloseTo(0.75, 10);
			expect(rows[0]?.lastActivity).toBe('2026-02-20T01:00:00.000Z');
		});
	});
}

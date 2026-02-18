import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchCodexPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CODEX_PROVIDER_PREFIXES = ['openai/', 'azure/', 'openrouter/openai/'];
const CODEX_MODEL_ALIASES_MAP = new Map<string, string>([
	['gpt-5-codex', 'gpt-5'],
	['gpt-5.3-codex', 'gpt-5.2-codex'],
]);

function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

function hasCompleteTokenPricing(
	pricing: LiteLLMModelPricing | null | undefined,
): pricing is LiteLLMModelPricing & {
	input_cost_per_token: number;
	output_cost_per_token: number;
} {
	return pricing?.input_cost_per_token != null && pricing.output_cost_per_token != null;
}

export type CodexPricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

const PREFETCHED_CODEX_PRICING = prefetchCodexPricing();

export class CodexPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;

	constructor(options: CodexPricingSourceOptions = {}) {
		this.fetcher = new LiteLLMPricingFetcher({
			offline: options.offline ?? false,
			offlineLoader: options.offlineLoader ?? (async () => PREFETCHED_CODEX_PRICING),
			logger,
			providerPrefixes: CODEX_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	private async getStrictPricing(model: string): Promise<LiteLLMModelPricing | null> {
		const pricingLookup = await this.fetcher.fetchModelPricing();
		if (Result.isFailure(pricingLookup)) {
			throw pricingLookup.error;
		}

		const pricingMap = pricingLookup.value;
		const candidates = [model, ...CODEX_PROVIDER_PREFIXES.map((prefix) => `${prefix}${model}`)];
		for (const candidate of candidates) {
			const pricing = pricingMap.get(candidate);
			if (pricing != null) {
				return pricing;
			}
		}

		return null;
	}

	private async getRelaxedPricing(model: string): Promise<LiteLLMModelPricing | null> {
		const lookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(lookup)) {
			throw lookup.error;
		}
		return lookup.value;
	}

	async getPricing(model: string): Promise<ModelPricing> {
		let pricing = await this.getStrictPricing(model);

		if (!hasCompleteTokenPricing(pricing)) {
			const alias = CODEX_MODEL_ALIASES_MAP.get(model);
			if (alias != null) {
				let aliasPricing = await this.getStrictPricing(alias);
				if (!hasCompleteTokenPricing(aliasPricing)) {
					aliasPricing = await this.getRelaxedPricing(alias);
				}
				if (hasCompleteTokenPricing(aliasPricing)) {
					pricing = aliasPricing;
				}
			}
		}

		if (!hasCompleteTokenPricing(pricing)) {
			const relaxedPricing = await this.getRelaxedPricing(model);
			if (hasCompleteTokenPricing(relaxedPricing)) {
				pricing = relaxedPricing;
			}
		}

		if (!hasCompleteTokenPricing(pricing)) {
			throw new Error(`Pricing not found for model ${model}`);
		}

		return {
			inputCostPerMToken: toPerMillion(pricing.input_cost_per_token),
			cachedInputCostPerMToken: toPerMillion(
				pricing.cache_read_input_token_cost,
				pricing.input_cost_per_token,
			),
			outputCostPerMToken: toPerMillion(pricing.output_cost_per_token),
		};
	}
}

if (import.meta.vitest != null) {
	describe('CodexPricingSource', () => {
		it('converts LiteLLM pricing to per-million costs', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.25);
			expect(pricing.outputCostPerMToken).toBeCloseTo(10);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.125);
		});

		it('falls back to gpt-5.2-codex pricing for gpt-5.3-codex when missing', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
					'gpt-5.2-codex': {
						input_cost_per_token: 1.5e-6,
						output_cost_per_token: 1.2e-5,
						cache_read_input_token_cost: 1.5e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5.3-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.5);
			expect(pricing.outputCostPerMToken).toBeCloseTo(12);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.15);
		});

		it('falls back to gpt-5.2-codex pricing when gpt-5.3-codex has no token rates', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5.3-codex': {
						max_tokens: 128_000,
						max_input_tokens: 128_000,
						max_output_tokens: 128_000,
					},
					'gpt-5.2-codex': {
						input_cost_per_token: 1.5e-6,
						output_cost_per_token: 1.2e-5,
						cache_read_input_token_cost: 1.5e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5.3-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.5);
			expect(pricing.outputCostPerMToken).toBeCloseTo(12);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.15);
		});
	});
}

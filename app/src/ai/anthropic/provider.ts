// src/ai/anthropic/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import type { Piece } from "../../core/piece.js";
import { AnthropicSessionFactory } from "./factory.js";
import { AnthropicMetricsHud } from "./metrics-hud.js";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const factory = new AnthropicSessionFactory(
    config.getTools,
    config.getCoreContext,
    config.getPluginInstructions,
    config.getPluginContext,
    config.getInstructions,
  );
  const metricsPiece = new AnthropicMetricsHud(factory);

  return {
    name: "anthropic",
    factory,
    metricsPiece,
  };
}

// src/ai/openai/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import { OpenAISessionFactory } from "./factory.js";
import { OpenAIMetricsHud } from "./metrics-hud.js";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const factory = new OpenAISessionFactory(
    config.getTools,
    () => {
      const core = config.getCoreContext().filter(Boolean);
      const pluginInstr = config.getPluginInstructions().filter(Boolean);
      const pluginCtx = config.getPluginContext().filter(Boolean);
      const instructions = config.getInstructions();
      const parts = [core.join("\n\n---\n\n"), pluginInstr.join("\n\n"), pluginCtx.join("\n\n")];
      if (instructions) parts.push(instructions);
      return parts.filter(Boolean).join("\n\n---\n\n");
    },
  );
  const metricsPiece = new OpenAIMetricsHud();

  return {
    name: "openai",
    factory,
    metricsPiece,
  };
}

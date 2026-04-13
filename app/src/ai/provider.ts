// src/ai/provider.ts
import type { EventBus } from "../core/bus.js";
import type { AISessionFactory } from "./types.js";
import type { Piece } from "../core/piece.js";
import { log } from "../logger/index.js";

export interface Provider {
  readonly name: string;
  readonly factory: AISessionFactory;
  readonly metricsPiece: Piece;
}

type CapabilityDefProvider = () => Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
type ContextProvider = () => string[];
type InstructionsProvider = () => string;

export interface ProviderConfig {
  getTools: CapabilityDefProvider;
  getCoreContext: ContextProvider;
  getPluginContext: ContextProvider;
  getInstructions: InstructionsProvider;
}

export class ProviderRouter {
  private active: Provider | undefined;
  private bus: EventBus | undefined;
  private providerConfig: ProviderConfig;
  private providerFactories = new Map<string, (config: ProviderConfig) => Provider>();

  constructor(providerConfig: ProviderConfig) {
    this.providerConfig = providerConfig;
  }

  registerProviderFactory(name: string, factory: (config: ProviderConfig) => Provider): void {
    this.providerFactories.set(name, factory);
  }

  getActiveProvider(): Provider | undefined {
    return this.active;
  }

  getFactory(): AISessionFactory {
    if (!this.active) throw new Error("No active provider");
    return this.active.factory;
  }

  async switchTo(providerName: string, bus: EventBus): Promise<string> {
    this.bus = bus;

    const createProvider = this.providerFactories.get(providerName);
    if (!createProvider) {
      return `Unknown provider: ${providerName}. Available: ${[...this.providerFactories.keys()].join(", ")}`;
    }

    // Stop current provider's metrics HUD
    if (this.active) {
      await this.active.metricsPiece.stop();
      log.info({ from: this.active.name, to: providerName }, "ProviderRouter: switching provider");
    }

    // Create and start new provider
    this.active = createProvider(this.providerConfig);
    await this.active.metricsPiece.start(bus);
    log.info({ provider: this.active.name }, "ProviderRouter: provider active");

    return `Provider switched to ${providerName}`;
  }

  getProviderNames(): string[] {
    return [...this.providerFactories.keys()];
  }
}

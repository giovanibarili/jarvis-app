// src/config/index.ts
import { load as loadSettings, save as saveSettings } from "../core/settings.js";

export interface JarvisConfig {
  model: string;
  grpcPort: number;
  grpcEnabled: boolean;
  logLevel: string;
  systemPromptPath: string;
}

const savedModel = loadSettings().model;

export const config: JarvisConfig = {
  model: process.env.JARVIS_MODEL ?? savedModel ?? "claude-sonnet-4-6",
  grpcPort: Number(process.env.JARVIS_GRPC_PORT ?? "50051"),
  grpcEnabled: process.env.JARVIS_GRPC_ENABLED !== "false",
  logLevel: process.env.LOG_LEVEL ?? "info",
  systemPromptPath: process.env.JARVIS_SYSTEM_PROMPT ?? "./jarvis-system.md",
};

const MODEL_PROVIDERS: Record<string, string> = {
  "claude-opus-4-7": "anthropic",
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "o3": "openai",
  "o4-mini": "openai",
};

export function getProviderForModel(model: string): string {
  // Exact match first
  if (MODEL_PROVIDERS[model]) return MODEL_PROVIDERS[model];
  // Prefix match: claude-* → anthropic, gpt-*/o* → openai
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  // Default to openai-compatible (works with Ollama, Groq, etc.)
  return "openai";
}

export function setModel(model: string): { message: string; providerChanged: boolean; provider: string } {
  const oldProvider = getProviderForModel(config.model);
  const newProvider = getProviderForModel(model);
  config.model = model;
  const settings = loadSettings();
  settings.model = model;
  saveSettings(settings);
  return {
    message: `Model switched to ${model} (${newProvider}).${oldProvider !== newProvider ? " Provider changed — session will reset." : ""}`,
    providerChanged: oldProvider !== newProvider,
    provider: newProvider,
  };
}

export function getValidModels(): string[] {
  return Object.keys(MODEL_PROVIDERS);
}

export function getCurrentProvider(): string {
  return getProviderForModel(config.model);
}

export function getMaxContext(model?: string): number {
  const m = model ?? config.model;
  if (m.includes("opus")) return 1_000_000;
  if (m.includes("haiku")) return 200_000;
  return 200_000; // sonnet and others
}

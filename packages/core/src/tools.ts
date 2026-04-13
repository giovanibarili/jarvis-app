export type CapabilityHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface CapabilityDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: CapabilityHandler;
}

export interface CapabilityCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ToolResultContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

export interface CapabilityResult {
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

export interface CapabilityRegistry {
  register(def: CapabilityDefinition): void;
  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  execute(calls: CapabilityCall[]): Promise<CapabilityResult[]>;
  readonly names: string[];
  readonly size: number;
}

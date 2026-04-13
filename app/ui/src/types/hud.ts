export type HudComponentConfig = {
  type: "panel" | "overlay" | "indicator";
  draggable: boolean;
  resizable: boolean;
};

export type HudComponentState = {
  id: string;
  name: string;
  status: string;
  visible?: boolean;
  hudConfig: HudComponentConfig;
  position: { x: number; y: number };
  size: { width: number; height: number };
  data: Record<string, unknown>;
  renderer?: { plugin: string; file: string };
};

export type HudReactor = {
  status: string;
  coreLabel: string;
  coreSubLabel: string;
};

export type HudState = {
  reactor: HudReactor;
  components: HudComponentState[];
};

export type HudNode = {
  id: string;
  label: string;
  value: string;
  color: string;
  pulse?: boolean;
  expanded?: boolean;
  children?: HudNode[];
};

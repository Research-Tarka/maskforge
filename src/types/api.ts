/**
 * TypeScript mirror of the Pydantic models and REST/WebSocket contract
 * defined in docs/IPC_CONTRACT.md. Keep this file in 1:1 sync with the
 * sidecar's schemas.py — the contract version below must match the
 * sidecar's IPC_CONTRACT_VERSION exactly.
 */

export const IPC_CONTRACT_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface ClassDef {
  id: string;
  name: string;
  color: [number, number, number];
  value: number;
  active_by_default: boolean;
}

export interface ClassPalette {
  id: string;
  name: string;
  classes: ClassDef[];
}

export type SceneMode = "annotate" | "review";

export type QaStatus = "todo" | "in_progress" | "validated" | "flagged";

export interface SceneEntry {
  id: string;
  raw_path: string | null;
  shadow_path: string | null;
  mask_path: string | null;
  detected_resolution: [number, number] | null;
  detected_crs: string | null;
  mode: SceneMode;
  qa_status: QaStatus;
}

export interface ScanRule {
  name: string;
  raw_patterns: string[];
  shadow_patterns: string[];
  mask_patterns: string[];
  max_depth: number;
  file_extensions: string[];
}

export interface DiscoveryConfig {
  source_root: string;
  scan_rule: ScanRule;
  exclude_globs: string[];
}

export type OutputFormat = "geotiff_rgba" | "geotiff_rgb" | "png" | "png_indexed";

export type ResolutionMode = "native" | "custom";

export interface SaveConfig {
  output_format: OutputFormat;
  output_root: string;
  folder_structure_template: string;
  copy_raw: boolean;
  copy_shadow: boolean;
  preserve_georef: boolean;
  resolution_mode: ResolutionMode;
  target_resolution: [number, number] | null;
  compress: string | null;
}

export interface SessionState {
  schema_version: number;
  id: string;
  name: string;
  discovery: DiscoveryConfig;
  active_palette_id: string;
  active_class_ids: string[];
  save_config: SaveConfig;
  /** Independent save config for a resampled "training" copy, saved via a
   * separate action (e.g. native-resolution Mask.tif alongside a
   * 30m-resampled Mask_Train.tif). Absent/null if unused. */
  training_save_config: SaveConfig | null;
  ui_state: Record<string, unknown>;
  qa_state: Record<string, unknown>;
  recent_sessions: string[];
}

export interface LayerData {
  width: number;
  height: number;
  crs: string | null;
  transform: number[] | null;
  png_base64: string;
}

export interface SceneLayers {
  raw: LayerData | null;
  shadow: LayerData | null;
  mask: LayerData | null;
}

export type ToolKind = "brush" | "bucket" | "polygon" | "autofill";

/** Everything /masks/{id}/tool accepts — the four interactive paint tools
 * plus "fill_all", a one-off action (not a selectable canvas mode). */
export type ApplyToolKind = ToolKind | "fill_all";

export interface ToolRequest {
  tool: ApplyToolKind;
  params: Record<string, unknown>;
  class_value: number;
  /** True for every brush stamp after the first one in a single drag, so
   * the whole dragged stroke collapses into a single undo step instead of
   * one step per stamp. */
  continue_stroke?: boolean;
}

export interface ToolResult {
  png_base64: string;
  bbox: [number, number, number, number];
}

export interface SaveMaskResult {
  path: string;
  bytes_written: number;
}

export type ClusterMethod = "kmeans" | "gmm";

/** Unsupervised clustering draft — see docs/IPC_CONTRACT.md. A rough
 * starting point to correct, not a classification result. CPU only. */
export interface AutoSegmentRequest {
  source: "raw" | "shadow" | "both";
  n_clusters: number;
  method: ClusterMethod;
  use_texture: boolean;
}

export interface AutoSegmentClusterInfo {
  cluster_id: number;
  mean_color: number[];
  /** Exact RGB this cluster is rendered as in preview_png_base64. */
  preview_color: [number, number, number];
}

export interface AutoSegmentResult {
  preview_png_base64: string;
  clusters: AutoSegmentClusterInfo[];
}

export interface ApplyAutoSegmentRequest {
  cluster_to_class: Record<number, number>;
}

export interface ApplyAutoSegmentComponentRequest {
  x: number;
  y: number;
  class_value: number;
}

export interface RemapRequest {
  old_color: [number, number, number];
  new_color: [number, number, number];
  dry_run: boolean;
}

export interface RemapResult {
  affected_pixels: number;
  applied: boolean;
}

export interface DeletedResult {
  deleted: true;
}

export interface HealthResult {
  status: "ok";
  version: string;
}

// ---------------------------------------------------------------------------
// Shadow generation
// ---------------------------------------------------------------------------

export type ShadowMethodName =
  | "percentile_arcsinh"
  | "clahe"
  | "hsv_threshold"
  | "dem_hillshade"
  | "custom";

export interface ShadowGenerateRequest {
  scene_id: string;
  method: ShadowMethodName;
  params: Record<string, unknown>;
}

export interface ShadowPreset {
  id: string;
  name: string;
  method: ShadowMethodName;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface ClassPixelStat {
  class_value: number;
  pixel_count: number;
}

export interface SceneStats {
  scene_id: string;
  total_pixels: number;
  classes: ClassPixelStat[];
}

export type StatsExportFormat = "csv" | "parquet";

export interface StatsExportRequest {
  scene_ids: string[];
  format: StatsExportFormat;
}

export interface StatsExportResult {
  path: string;
}

// ---------------------------------------------------------------------------
// WebSocket progress channel
// ---------------------------------------------------------------------------

export interface ProgressMessage {
  job_id: string;
  phase: string;
  progress: number;
  message: string;
}

/**
 * TypeScript mirror of the Pydantic models and REST/WebSocket contract
 * defined in docs/IPC_CONTRACT.md. Keep this file in 1:1 sync with the
 * sidecar's schemas.py — the contract version below must match the
 * sidecar's IPC_CONTRACT_VERSION exactly.
 */

export const IPC_CONTRACT_VERSION = "1.4.0";

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
  /** Every RGB composite view this scene has, {view_name: composite_path}
   * (e.g. "rgb_true_color", "rgb_natural_color", "rgb_color_infrared").
   * Only populated for a zarr-backed scene; empty for a plain-file scene
   * (where raw_path/shadow_path are the only two views that can exist). */
  rgb_composites: Record<string, string>;
  /** Path to an inference class-map raster produced by an external ML
   * pipeline, if one was found for this scene (.npz or GeoTIFF). Null means
   * no inference is available -- the "Copy inference to mask" action stays
   * disabled in that case. */
  inference_path: string | null;
}

export interface ScanRule {
  name: string;
  /** Filenames matching any of these are recognized as this scene's RGB
   * source image (a single field -- there is no separate raw/shadow pair
   * in current usage). */
  rgb_patterns: string[];
  mask_patterns: string[];
  /** Filenames matching any of these are recognized as an inference
   * class-map raster (see sidecar's plugins/inference_reader.py). */
  inference_patterns: string[];
  max_depth: number;
  file_extensions: string[];
}

export interface DiscoveryConfig {
  source_root: string;
  scan_rule: ScanRule;
  exclude_globs: string[];
  /** Root of an external ML pipeline's inference output, for resolving a
   * zarr-store scene's inference class map. Null means no inference is
   * available for any zarr scene. */
  inference_root: string | null;
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
  /** Every RGB composite view currently rendered, keyed by view name (e.g.
   * "rgb_true_color") -- replaces the old fixed raw/shadow pair now that a
   * scene can have up to 4 (or more) RGB visuals. Only the views requested
   * from getSceneLayers are populated. */
  rgb: Record<string, LayerData>;
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
  /** [y0, x0, y1, x1] (row-major, matching the sidecar's BBox convention in
   * contours.py::bbox_from_change_mask) -- NOT [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** The scene's QA status after this change was applied (see the
   * sidecar's masks.py::_auto_update_qa_status) -- server-derived, so the
   * frontend should sync its local scene list from this rather than
   * assuming its own prior value still holds. */
  qa_status: QaStatus;
}

export interface SaveMaskResult {
  path: string;
  bytes_written: number;
  /** Always "validated" after a successful save -- an explicit override,
   * even for a scene that was "flagged". */
  qa_status: QaStatus;
}

export type ClusterMethod = "kmeans" | "gmm";

/** Unsupervised clustering draft — see docs/IPC_CONTRACT.md. A rough
 * starting point to correct, not a classification result. CPU only. */
export interface AutoSegmentRequest {
  /** Which RGB composite view(s) to cluster on, by name (e.g.
   * ["rgb_true_color", "rgb_color_infrared"]) -- at least one required.
   * Multiple sources are stacked band-wise before clustering. */
  sources: string[];
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
  qa_status: QaStatus;
}

/** Reassigns every pixel currently at old_value to new_value, matched by
 * class value (not rendered color like RemapRequest) -- safe to use with
 * the reserved Nodata pseudo-class (value 255), which /remap's color-based
 * matching cannot distinguish from any real class that also renders white. */
export interface SwapClassRequest {
  old_value: number;
  new_value: number;
  dry_run: boolean;
}

export interface SwapClassResult {
  affected_pixels: number;
  applied: boolean;
  qa_status: QaStatus;
}

export interface DeletedResult {
  deleted: true;
}

export interface HealthResult {
  status: "ok";
  version: string;
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

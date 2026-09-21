/**
 * Parses a SceneEntry.id ("{tile_id}_{sensor}_{scene_id}") back into its
 * (tile_id, sensor, scene_id) triple and derives (year, month) from
 * scene_id, mirroring the sidecar's own id construction
 * (maskforge_core/scene_discovery.py::_scan_zarr_store).
 *
 * Non-zarr-discovered scenes (plain file trees) don't necessarily follow
 * this id shape -- every function here returns null on a no-match rather
 * than throwing, so callers can render "unknown" for those instead of
 * crashing the QA panel.
 */

const KNOWN_SENSORS = ["l5", "l7", "l8", "l9", "s2"];

//: Landsat scene ids end in an 8-digit acquisition date, e.g.
//: "LC08_048021_20230729" -> year 2023, month 07.
const LANDSAT_DATE_RE = /_(\d{4})(\d{2})(\d{2})$/;
//: Sentinel-2 scene ids start with a 15-char acquisition timestamp, e.g.
//: "20230607T191911_20230607T192455_T10VEH" -> year 2023, month 06.
const S2_DATE_RE = /^(\d{4})(\d{2})(\d{2})T\d{6}/;

export interface ParsedSceneKey {
  tileId: string;
  sensor: string;
  sceneId: string;
  /** Acquisition year, or null if it couldn't be parsed from scene_id. */
  year: number | null;
  /** Acquisition month (1-12), or null if it couldn't be parsed. */
  month: number | null;
}

/** Split "{tile_id}_{sensor}_{scene_id}" by matching the sensor segment
 * case-insensitively against KNOWN_SENSORS (not a positional split --
 * both tile_id and scene_id themselves contain underscores). */
export function parseSceneKey(sceneKey: string): { tileId: string; sensor: string; sceneId: string } | null {
  const parts = sceneKey.split("_");
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts[i].toLowerCase();
    if (KNOWN_SENSORS.includes(candidate)) {
      const tileId = parts.slice(0, i).join("_");
      const sceneId = parts.slice(i + 1).join("_");
      if (tileId && sceneId) {
        return { tileId, sensor: candidate, sceneId };
      }
    }
  }
  return null;
}

function parseAcquisitionDate(sensor: string, sceneId: string): { year: number; month: number } | null {
  const match = sensor.toUpperCase() === "S2" ? S2_DATE_RE.exec(sceneId) : LANDSAT_DATE_RE.exec(sceneId);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function parseSceneEntryId(sceneEntryId: string): ParsedSceneKey | null {
  const parsed = parseSceneKey(sceneEntryId);
  if (!parsed) return null;
  const date = parseAcquisitionDate(parsed.sensor, parsed.sceneId);
  return {
    tileId: parsed.tileId,
    sensor: parsed.sensor,
    sceneId: parsed.sceneId,
    year: date?.year ?? null,
    month: date?.month ?? null,
  };
}

export const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

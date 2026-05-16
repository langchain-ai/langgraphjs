import { isRecord } from "../../utils";
import { parseToolPayload } from "./toolCardUtils";

interface LocationResult {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp?: string;
  saved?: boolean;
}

const readNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

export const readLocationResult = (
  value: unknown
): LocationResult | undefined => {
  const parsed = parseToolPayload(value);
  if (!isRecord(parsed)) return undefined;

  const latitude = readNumber(parsed, "latitude");
  const longitude = readNumber(parsed, "longitude");
  if (latitude != null && longitude != null) {
    return {
      latitude,
      longitude,
      accuracy: readNumber(parsed, "accuracy"),
      timestamp:
        typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      saved: typeof parsed.saved === "boolean" ? parsed.saved : undefined,
    };
  }

  for (const nested of Object.values(parsed)) {
    const result = readLocationResult(nested);
    if (result != null) return result;
  }

  return undefined;
};

const getOpenStreetMapEmbedUrl = ({ latitude, longitude }: LocationResult) => {
  const delta = 0.01;
  const params = new URLSearchParams({
    bbox: [
      longitude - delta,
      latitude - delta,
      longitude + delta,
      latitude + delta,
    ].join(","),
    layer: "mapnik",
    marker: `${latitude},${longitude}`,
  });
  return `https://www.openstreetmap.org/export/embed.html?${params}`;
};

export function LocationToolResult({ result }: { result: LocationResult }) {
  const mapsUrl = `https://www.openstreetmap.org/?mlat=${result.latitude}&mlon=${result.longitude}#map=15/${result.latitude}/${result.longitude}`;
  return (
    <div className="location-tool-result">
      <iframe
        className="location-tool-map"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        src={getOpenStreetMapEmbedUrl(result)}
        title="Geolocation result map"
      />
      <div className="location-tool-details">
        <div>
          <span>Latitude</span>
          <strong>{result.latitude.toFixed(6)}</strong>
        </div>
        <div>
          <span>Longitude</span>
          <strong>{result.longitude.toFixed(6)}</strong>
        </div>
        {result.accuracy != null ? (
          <div>
            <span>Accuracy</span>
            <strong>{Math.round(result.accuracy)} m</strong>
          </div>
        ) : null}
        {result.saved != null ? (
          <div>
            <span>Saved</span>
            <strong>{result.saved ? "Yes" : "No"}</strong>
          </div>
        ) : null}
      </div>
      <a className="map-link" href={mapsUrl} rel="noreferrer" target="_blank">
        Open in OpenStreetMap
      </a>
    </div>
  );
}

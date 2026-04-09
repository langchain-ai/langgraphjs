import type { PlaygroundTransportMode } from "../../components/ProtocolSwitcher";
import { isProtocolTransportMode } from "../shared";
import { LegacyParallelSubagentsView } from "./legacy";
import { ProtocolParallelSubagentsView } from "./protocol";

export function ParallelSubagentsView({
  transportMode,
}: {
  transportMode: PlaygroundTransportMode;
}) {
  return isProtocolTransportMode(transportMode) ? (
    <ProtocolParallelSubagentsView transportMode={transportMode} />
  ) : (
    <LegacyParallelSubagentsView />
  );
}

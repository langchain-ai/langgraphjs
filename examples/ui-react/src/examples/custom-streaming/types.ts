/**
 * Progress data emitted during data analysis
 */
export interface ProgressData {
  type: "progress";
  id: string;
  step: string;
  message: string;
  progress: number;
  totalSteps: number;
  currentStep: number;
}

/**
 * Status data for completion events
 */
export interface StatusData {
  type: "status";
  id: string;
  status: "complete" | "error";
  message: string;
}

/**
 * File status data for file operations
 */
export interface FileStatusData {
  type: "file-status";
  id: string;
  filename: string;
  operation: "read" | "compress" | "validate" | "transform";
  status: "started" | "completed" | "error";
  size?: string;
}

/**
 * Union type for all custom streaming data types
 */
export type CustomStreamData = ProgressData | StatusData | FileStatusData;

/**
 * Type guard for ProgressData
 */
export function isProgressData(data: unknown): data is ProgressData {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as ProgressData).type === "progress"
  );
}

/**
 * Type guard for StatusData
 */
export function isStatusData(data: unknown): data is StatusData {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as StatusData).type === "status"
  );
}

/**
 * Type guard for FileStatusData
 */
export function isFileStatusData(data: unknown): data is FileStatusData {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as FileStatusData).type === "file-status"
  );
}


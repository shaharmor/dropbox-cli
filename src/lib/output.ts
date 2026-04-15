let humanMode = false;

export function setHumanMode(value: boolean): void {
  humanMode = value;
}

export function isHuman(): boolean {
  return humanMode;
}

export interface SuccessEnvelope<T = unknown> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export function formatSuccess<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}

export function formatError(code: string, message: string): ErrorEnvelope {
  return { ok: false, error: { code, message } };
}

export function printSuccess<T>(data: T): void {
  console.log(JSON.stringify(formatSuccess(data), null, 2));
}

export function printError(code: string, message: string, exitCode = 1): never {
  console.log(JSON.stringify(formatError(code, message), null, 2));
  process.exit(exitCode);
}

export function printAuthError(message: string): never {
  printError("auth_error", message, 2);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

import { CredentialError, MachineError, type MachineErrorDetails, type MachineOptions, type RequestOptions } from "../types";

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
    details?: MachineErrorDetails;
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

// Machine errors never echo argv, local exceptions, or response bodies as diagnostics.
export function printMachineError(error: unknown): void {
  const failure = error instanceof MachineError ? error : error instanceof CredentialError
    ? new MachineError(error.code, error.message)
    : new MachineError("machine_error", "The operation could not be completed.");
  console.log(JSON.stringify({ ok: false, error: {
    code: failure.code, message: failure.message, details: failure.details,
  } }));
  process.exitCode = failure instanceof MachineError && failure.code === "auth_error" ? 2 : 1;
}

export async function runMachine(options: MachineOptions, operation: (request: RequestOptions) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!options.expectedAccount?.trim()) throw new MachineError("invalid_args", "--expected-account is required.");
    const seconds = Number(options.timeout ?? "120");
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
      throw new MachineError("invalid_args", "--timeout must be between 1 and 600 seconds.");
    }
    timer = setTimeout(cancel, seconds * 1000);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const data = await operation({ expectedAccountId: options.expectedAccount, signal: controller.signal, machine: true });
    printSuccess(data);
  } catch (error) { printMachineError(error); }
  finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
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

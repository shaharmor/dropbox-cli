import { isHuman } from "./output";

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function log(...args: unknown[]): void {
  if (verbose) {
    console.error("[verbose]", ...args);
  }
}

export function logError(...args: unknown[]): void {
  console.error(...args);
}

export function logHuman(...args: unknown[]): void {
  if (isHuman()) {
    console.error(...args);
  }
}

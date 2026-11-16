import { InvalidArgumentError } from "commander";

/** Commander option parser for a whole number of at least 1 and at most `max`, when given. */
export function positiveInteger(max?: number): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || parsed < 1 || (max !== undefined && parsed > max)) {
      throw new InvalidArgumentError(max === undefined ? "Must be a positive integer." : `Must be an integer from 1 to ${max}.`);
    }
    return parsed;
  };
}

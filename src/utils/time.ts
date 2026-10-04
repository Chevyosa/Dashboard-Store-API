export type Clock = () => Date;

export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const TOUCH_INTERVAL_MS = 60 * 1000;

// DATETIME(3) values are UTC and travel as 'YYYY-MM-DD HH:mm:ss.SSS' strings.
export function toMysqlUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

export function fromMysqlUtc(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

export const systemClock: Clock = () => new Date();
export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

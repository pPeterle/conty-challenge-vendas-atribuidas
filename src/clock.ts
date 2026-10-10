export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Relógio controlável para testes. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date | string = "2026-01-01T12:00:00.000Z") {
    this.#current = new Date(start);
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(at: Date | string): void {
    this.#current = new Date(at);
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }
}

/**
 * Test-only view of untrusted JSON.
 *
 * The translators accept and return `Record<string, unknown>`: correct for
 * production, where every nested read is narrowed before use, but unwieldy in
 * assertions that index several levels deep. Tests assert the recursive shape
 * once at the boundary instead of sprinkling casts through each expectation.
 *
 * This is deliberately not `any`: values are still `Json`, so using one as a
 * number or calling it is a type error.
 */
export type Json = { [key: string]: Json } & { [key: number]: Json };

export function json(value: unknown): Json {
  return value as Json;
}

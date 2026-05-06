import { describe, expect, it } from "vitest";

import {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_MAX_AGE_SEC,
  SESSION_IDLE_MS,
} from "../../server/src/auth/sessionConfig";

const HONO_MAX_COOKIE_AGE_SEC = 400 * 24 * 60 * 60;

describe("session config", () => {
  it("keeps the cookie max age within Hono's 400-day limit", () => {
    // Arrange
    const maxAllowedCookieAge = HONO_MAX_COOKIE_AGE_SEC;

    // Act
    const cookieMaxAge = SESSION_COOKIE_MAX_AGE_SEC;

    // Assert
    expect(cookieMaxAge).toBeLessThanOrEqual(maxAllowedCookieAge);
  });

  it("keeps server sessions longer lived than the cookie refresh window", () => {
    // Arrange
    const cookieMaxAgeMs = SESSION_COOKIE_MAX_AGE_SEC * 1000;

    // Act
    const absoluteSessionLifetime = SESSION_ABSOLUTE_MS;
    const idleSessionLifetime = SESSION_IDLE_MS;

    // Assert
    expect(absoluteSessionLifetime).toBeGreaterThan(cookieMaxAgeMs);
    expect(idleSessionLifetime).toBeGreaterThan(cookieMaxAgeMs);
  });
});

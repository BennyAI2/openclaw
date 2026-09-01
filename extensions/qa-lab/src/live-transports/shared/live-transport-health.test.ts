import { describe, expect, it, vi } from "vitest";
import { assertPollingTransportHealthy } from "./live-transport-health.js";

describe("polling transport health", () => {
  it("throws the polling failure before checking the lease heartbeat", () => {
    const pollingError = new Error("polling failed");
    const throwIfFailed = vi.fn(() => {
      throw new Error("heartbeat failed");
    });

    try {
      assertPollingTransportHealthy(pollingError, { throwIfFailed });
      throw new Error("expected transport health failure");
    } catch (error) {
      expect(error).toBe(pollingError);
    }
    expect(throwIfFailed).not.toHaveBeenCalled();
  });

  it("preserves the lease heartbeat failure when polling is healthy", () => {
    const heartbeatError = new Error("heartbeat failed");

    try {
      assertPollingTransportHealthy(undefined, {
        throwIfFailed() {
          throw heartbeatError;
        },
      });
      throw new Error("expected transport health failure");
    } catch (error) {
      expect(error).toBe(heartbeatError);
    }
  });
});

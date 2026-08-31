import type { ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ModelProviderLoginController } from "./login-controller.ts";

describe("ModelProviderLoginController", () => {
  it("cancels an admitted Gateway wizard on reset before another login starts", async () => {
    let runningSessionId: string | null = null;
    let starts = 0;
    const request = vi.fn(
      async (method: string, params?: { sessionId?: string }): Promise<unknown> => {
        if (method === "models.authLogin.start") {
          if (runningSessionId) {
            throw new Error("wizard already running");
          }
          starts += 1;
          if (starts === 1) {
            runningSessionId = params?.sessionId ?? null;
            return { sessionId: runningSessionId, done: false, status: "running" };
          }
          return { sessionId: params?.sessionId, done: true, status: "done" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: {
              id: "device-code",
              type: "note",
              executor: "client",
              message: "Continue in the provider browser.",
            },
          };
        }
        if (method === "wizard.cancel") {
          expect(params?.sessionId).toBe(runningSessionId);
          runningSessionId = null;
          return { status: "cancelled" };
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const host = {
      addController: vi.fn(),
      requestUpdate: vi.fn(),
    } as unknown as ReactiveControllerHost;
    const refresh = vi.fn(async () => undefined);
    const controller = new ModelProviderLoginController(host, {
      getClient: () => ({ request }) as unknown as GatewayBrowserClient,
      getAgentId: () => "main",
      canStart: () => true,
      refresh,
      setMessage: vi.fn(),
    });

    controller.start("xai", { id: "xai-oauth", label: "xAI OAuth", kind: "device-code" });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("wizard.next", expect.anything(), expect.anything()),
    );
    expect(runningSessionId).not.toBeNull();

    controller.reset();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: expect.any(String) },
        { timeoutMs: 30_000 },
      ),
    );
    expect(runningSessionId).toBeNull();

    controller.start("xai", { id: "xai-oauth", label: "xAI OAuth", kind: "device-code" });
    await vi.waitFor(() => expect(starts).toBe(2));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });
});

import type { ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ModelProviderLoginController } from "./login-controller.ts";

describe("ModelProviderLoginController", () => {
  it("cancels an admitted Gateway wizard on reset before another login starts", async () => {
    let runningSessionId: string | null = null;
    let starts = 0;
    let confirmRelease!: () => void;
    const releaseConfirmed = new Promise<void>((resolve) => {
      confirmRelease = resolve;
    });
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
          return { status: "cancelled" };
        }
        if (method === "wizard.status") {
          expect(params?.sessionId).toBe(runningSessionId);
          await releaseConfirmed;
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
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new ModelProviderLoginController(host, {
      getClient: () => client,
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
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.status",
        { sessionId: expect.any(String) },
        { timeoutMs: 30_000 },
      ),
    );
    controller.start("xai", { id: "xai-oauth", label: "xAI OAuth", kind: "device-code" });
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(controller.busy).toBe(true);

    confirmRelease();
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    controller.start("xai", { id: "xai-oauth", label: "xAI OAuth", kind: "device-code" });
    await vi.waitFor(() => expect(starts).toBe(2));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("keeps sign-in busy until a commit-locked login releases admission", async () => {
    let running = true;
    let starts = 0;
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "models.authLogin.start") {
        starts += 1;
        if (starts > 1 && running) {
          throw new Error("wizard already running");
        }
        return { sessionId: `login-${starts}`, done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: { id: "device-code", type: "note", executor: "client" },
        };
      }
      if (method === "wizard.cancel") {
        return { status: running ? "running" : "done" };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const host = {
      addController: vi.fn(),
      requestUpdate: vi.fn(),
    } as unknown as ReactiveControllerHost;
    const controller = new ModelProviderLoginController(host, {
      getClient: () => ({ request }) as unknown as GatewayBrowserClient,
      getAgentId: () => "main",
      canStart: () => true,
      refresh: vi.fn(async () => undefined),
      setMessage: vi.fn(),
    });

    controller.start("xai", { id: "xai-oauth", label: "xAI OAuth", kind: "device-code" });
    await vi.waitFor(() => expect(starts).toBe(1));
    controller.reset();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: expect.any(String) },
        { timeoutMs: 30_000 },
      ),
    );

    controller.start("xai", { id: "xai-oauth", label: "xAI OAuth", kind: "device-code" });
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toHaveLength(2),
    );
    expect(starts).toBe(1);
    expect(controller.busy).toBe(true);

    running = false;
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    controller.start("xai", { id: "xai-oauth", label: "xAI OAuth", kind: "device-code" });
    await vi.waitFor(() => expect(starts).toBe(2));
  });
});

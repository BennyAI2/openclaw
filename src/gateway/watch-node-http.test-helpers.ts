import { request as httpRequest, type ClientRequest } from "node:http";
import { expect, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { listNodePairing } from "../infra/device-pairing-node.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";

export function makeConnectParams(params: {
  identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
  nonce: string;
  bootstrapToken?: string;
  deviceToken?: string;
  client?: Partial<ConnectParams["client"]>;
  caps?: string[];
  commands?: string[];
  permissions?: ConnectParams["permissions"];
  minProtocol?: number;
  maxProtocol?: number;
  signedAt?: number;
}): ConnectParams {
  const publicKey = publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem);
  const auth = params.deviceToken
    ? { deviceToken: params.deviceToken }
    : { bootstrapToken: params.bootstrapToken };
  const signedAt = params.signedAt ?? Date.now();
  const client: ConnectParams["client"] = {
    id: GATEWAY_CLIENT_IDS.WATCHOS_APP,
    displayName: "Test Watch",
    version: "1.0.0",
    platform: "watchOS 11.5.0",
    deviceFamily: "Apple Watch",
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: "watch-test",
    ...params.client,
  };
  const scopes: string[] = [];
  const signaturePayload = buildDeviceAuthPayloadV3({
    deviceId: params.identity.deviceId,
    clientId: client.id,
    clientMode: client.mode,
    role: "node",
    scopes,
    signedAtMs: signedAt,
    token: params.deviceToken ?? params.bootstrapToken ?? null,
    nonce: params.nonce,
    platform: client.platform,
    deviceFamily: client.deviceFamily,
  });
  return {
    minProtocol: params.minProtocol ?? PROTOCOL_VERSION,
    maxProtocol: params.maxProtocol ?? PROTOCOL_VERSION,
    client,
    caps: params.caps ?? [],
    commands: params.commands ?? ["device.info", "device.status", "system.notify"],
    permissions: params.permissions ?? { notifications: true },
    role: "node",
    scopes,
    auth,
    device: {
      id: params.identity.deviceId,
      publicKey,
      signature: signDevicePayload(params.identity.privateKeyPem, signaturePayload),
      signedAt,
      nonce: params.nonce,
    },
  } as ConnectParams;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export async function connectWatchNode(params: {
  baseUrl: string;
  identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
  client?: Partial<ConnectParams["client"]>;
  bootstrapToken?: string;
  deviceToken?: string;
  permissions?: ConnectParams["permissions"];
}): Promise<Response> {
  const challenge = await readJson(await fetch(`${params.baseUrl}/challenge`));
  return await fetch(`${params.baseUrl}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      makeConnectParams({
        identity: params.identity,
        client: params.client,
        nonce: String(challenge.nonce),
        signedAt: Number(challenge.ts),
        bootstrapToken: params.bootstrapToken,
        deviceToken: params.deviceToken,
        permissions: params.permissions,
      }),
    ),
  });
}

export function startPartialJsonRequest(params: { url: string; authorization: string }): {
  request: ClientRequest;
  response: Promise<{ statusCode: number; body: string }>;
} {
  let request!: ClientRequest;
  const response = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    request = httpRequest(
      params.url,
      {
        method: "POST",
        headers: {
          authorization: params.authorization,
          "content-type": "application/json",
        },
      },
      (result) => {
        const chunks: Buffer[] = [];
        result.on("data", (chunk: Buffer) => chunks.push(chunk));
        result.once("end", () => {
          resolve({
            statusCode: result.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
  });
  return { request, response };
}

export async function waitForLastConnectedMetadata(baseDir: string, nodeId: string): Promise<void> {
  await vi.waitFor(async () => {
    const paired = (await listNodePairing(baseDir)).paired.find((entry) => entry.nodeId === nodeId);
    expect(paired?.lastConnectedAtMs).toEqual(expect.any(Number));
  });
}

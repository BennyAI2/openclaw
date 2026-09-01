import { expect, it } from "vitest";
import { protocolSchemaSignature } from "../../scripts/lib/protocol-schema-signature.mts";

it("projects protocol schema keys recursively before stringifying", () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = { b: 2, a: 1 };

  expect(protocolSchemaSignature({ a: 0, Z: sparse })).toBe('{"Z":[null,{"a":1,"b":2}],"a":0}');
});

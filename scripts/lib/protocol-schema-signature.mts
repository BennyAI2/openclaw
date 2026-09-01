function projectProtocolSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(projectProtocolSchema);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, projectProtocolSchema(record[key])]),
    );
  }
  return value;
}

export function protocolSchemaSignature(schema: unknown): string {
  return JSON.stringify(projectProtocolSchema(schema));
}

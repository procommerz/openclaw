function safeJsonReplacer(_key: string, val: unknown): unknown {
  if (typeof val === "bigint") {
    return val.toString();
  }
  if (typeof val === "function") {
    return "[Function]";
  }
  if (val instanceof Error) {
    return { name: val.name, message: val.message, stack: val.stack };
  }
  if (val instanceof Uint8Array) {
    return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
  }
  return val;
}

export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, safeJsonReplacer);
  } catch {
    return null;
  }
}

/**
 * Like `safeJsonStringify` but with 2-space indentation and `\n` escape
 * sequences inside string values replaced with real newlines, making long
 * prompt/completion texts readable directly in log viewers.
 */
export function safeJsonStringifyPretty(value: unknown): string | null {
  try {
    const json = JSON.stringify(value, safeJsonReplacer, 2);
    // Replace escaped newlines inside JSON string values with real newlines.
    // The pattern matches \\n that appear between double-quoted JSON string
    // boundaries; we target only the literal two-character sequence \n.
    return json.replace(/\\n/g, "\n");
  } catch {
    return null;
  }
}

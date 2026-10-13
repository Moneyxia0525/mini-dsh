/**
 * 轻量 JSON Schema 子集校验器。
 *
 * 工具参数只需要 object / properties / required / additionalProperties /
 * primitive type 这些能力，完整 JSON Schema 实现会给这个小型 runtime 引入
 * 不必要的复杂度。
 */
export function validateToolArguments(
  schema: Record<string, unknown>,
  value: unknown,
): string | undefined {
  if (schema.type && schema.type !== "object") {
    return `工具 schema 顶层必须是 object，实际为 ${String(schema.type)}`;
  }
  if (!isRecord(value)) return "工具参数必须是 JSON object";

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    if (!(name in value)) return `缺少必填参数 "${String(name)}"`;
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, arg] of Object.entries(value)) {
    const definition = properties[name];
    if (!definition) {
      if (schema.additionalProperties === false) {
        return `不允许的参数 "${name}"`;
      }
      continue;
    }
    if (!isRecord(definition)) continue;
    const error = validateValue(name, arg, definition);
    if (error) return error;
  }
  return undefined;
}

function validateValue(name: string, value: unknown, schema: Record<string, unknown>): string | undefined {
  const type = schema.type;
  if (typeof type !== "string") return undefined;

  const valid =
    type === "string" ? typeof value === "string"
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "integer" ? typeof value === "number" && Number.isInteger(value)
          : type === "boolean" ? typeof value === "boolean"
            : type === "array" ? Array.isArray(value)
              : type === "object" ? isRecord(value)
                : true;
  if (!valid) return `参数 "${name}" 类型错误，期望 ${type}`;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return `参数 "${name}" 长度不能小于 ${schema.minLength}`;
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return `参数 "${name}" 长度不能超过 ${schema.maxLength}`;
    }
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

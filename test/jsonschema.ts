// A JSON Schema (2020-12) check for the keywords schema/team.schema.json uses, so a test can hold the schema and
// lib/config.ts to the same answers without a dependency. A keyword it doesn't know is an error, not a pass.
type Schema = boolean | { [keyword: string]: unknown };

const KNOWN = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "pattern",
  "minLength",
  "format",
  "minimum",
  "exclusiveMinimum",
  "required",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const typeOf = (value: unknown): string[] => {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array"];
  if (typeof value === "number") return Number.isInteger(value) ? ["integer", "number"] : ["number"];
  return [typeof value];
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function validator(root: Record<string, unknown>): (value: unknown) => string[] {
  const resolve = (ref: string): Schema => {
    let node: unknown = root;
    for (const key of ref.replace(/^#\//, "").split("/")) node = isObject(node) ? node[key] : undefined;
    if (node === undefined) throw new Error(`no ${ref} in the schema`);
    return node as Schema;
  };
  const passes = (schema: Schema, value: unknown): boolean => {
    const errors: string[] = [];
    check(schema, value, "", errors);
    return !errors.length;
  };

  function check(schema: Schema, value: unknown, at: string, errors: string[]): void {
    if (schema === true) return;
    if (schema === false) return void errors.push(`${at}: not allowed`);
    const fail = (what: string) => errors.push(`${at || "/"}: ${what}`);
    for (const keyword of Object.keys(schema)) if (!KNOWN.has(keyword)) throw new Error(`the test's schema check doesn't know "${keyword}"`);

    if (typeof schema.$ref === "string") check(resolve(schema.$ref), value, at, errors);
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!typeOf(value).some((type) => types.includes(type))) fail(`not ${types.join(" or ")}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) fail("not one of the options");
    if ("const" in schema && !same(schema.const, value)) fail(`not ${JSON.stringify(schema.const)}`);

    if (typeof value === "string") {
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) fail(`doesn't match ${schema.pattern}`);
      if (typeof schema.minLength === "number" && [...value].length < schema.minLength) fail("too short");
      if (schema.format === "regex") {
        try {
          new RegExp(value);
        } catch {
          fail("not a regular expression");
        }
      } else if (schema.format !== undefined) throw new Error(`the test's schema check doesn't know format ${String(schema.format)}`);
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) fail(`below ${schema.minimum}`);
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) fail(`not above ${schema.exclusiveMinimum}`);
    }

    if (isObject(value)) {
      for (const key of Array.isArray(schema.required) ? schema.required : []) if (!(key in value)) fail(`needs ${key}`);
      const properties = isObject(schema.properties) ? schema.properties : {};
      const patterns = isObject(schema.patternProperties) ? schema.patternProperties : {};
      for (const [key, item] of Object.entries(value)) {
        let matched = false;
        if (Object.hasOwn(properties, key)) {
          matched = true;
          check(properties[key] as Schema, item, `${at}/${key}`, errors);
        }
        for (const [pattern, sub] of Object.entries(patterns))
          if (new RegExp(pattern, "u").test(key)) {
            matched = true;
            check(sub as Schema, item, `${at}/${key}`, errors);
          }
        if (!matched && schema.additionalProperties !== undefined) check(schema.additionalProperties as Schema, item, `${at}/${key}`, errors);
        if (schema.propertyNames !== undefined) check(schema.propertyNames as Schema, key, `${at}/${key} (name)`, errors);
      }
    }

    if (Array.isArray(value)) {
      const prefix = Array.isArray(schema.prefixItems) ? (schema.prefixItems as Schema[]) : [];
      value.forEach((item, i) => {
        if (i < prefix.length) check(prefix[i] as Schema, item, `${at}/${i}`, errors);
        else if (schema.items !== undefined) check(schema.items as Schema, item, `${at}/${i}`, errors);
      });
      if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(`fewer than ${schema.minItems}`);
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(`more than ${schema.maxItems}`);
    }

    if (Array.isArray(schema.allOf)) for (const sub of schema.allOf as Schema[]) check(sub, value, at, errors);
    if (Array.isArray(schema.anyOf) && !(schema.anyOf as Schema[]).some((sub) => passes(sub, value))) fail("matches none of anyOf");
    if (Array.isArray(schema.oneOf) && (schema.oneOf as Schema[]).filter((sub) => passes(sub, value)).length !== 1)
      fail("doesn't match exactly one of oneOf");
    if (schema.if !== undefined) {
      const branch = passes(schema.if as Schema, value) ? schema.then : schema.else;
      if (branch !== undefined) check(branch as Schema, value, at, errors);
    }
  }

  return (value: unknown) => {
    const errors: string[] = [];
    check(root, value, "", errors);
    return errors;
  };
}

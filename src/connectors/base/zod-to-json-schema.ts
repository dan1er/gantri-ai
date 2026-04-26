import type { z } from 'zod';

/**
 * Minimal zod → JSON Schema converter for Claude's tool manifest. Covers the
 * primitive shapes plus arrays, objects, defaults, optionals, and unions —
 * which is everything the connectors in this repo need today. NOT a complete
 * implementation of the spec; if you hit a `default: {}` for a tool, the schema
 * has a node type this converter doesn't handle yet — extend the switch below.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def: any = (schema as any)._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, child] of Object.entries<any>(shape)) {
        properties[k] = zodToJsonSchema(child);
        if (!('defaultValue' in (child as any)._def) && !((child as any).isOptional?.())) {
          required.push(k);
        }
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType);
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);
    case 'ZodUnion':
      return { anyOf: def.options.map((o: z.ZodTypeAny) => zodToJsonSchema(o)) };
    case 'ZodLiteral':
      return { const: def.value };
    default:
      return {};
  }
}

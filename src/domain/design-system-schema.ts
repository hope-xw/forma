import { z } from "zod";
import { styleSchema } from "./node";
import { variableProperties } from "./design-properties";
const id = z.string().min(1).max(128);
export const variableValueSchema = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.boolean(),
  z.object({ alias: id }),
]);
export const collectionSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  defaultModeId: id,
  modes: z
    .array(z.object({ id, name: z.string().min(1).max(100) }))
    .min(1)
    .max(20),
});
export const platformCodeSyntaxSchema = z.object({
  web: z.string().max(200).optional(),
  react: z.string().max(200).optional(),
  ios: z.string().max(200).optional(),
  android: z.string().max(200).optional(),
});
export const variableSchema = z.object({
  id,
  collectionId: id,
  name: z.string().min(1).max(200),
  type: z.enum(["color", "number", "string", "boolean"]),
  description: z.string().max(2000).default(""),
  codeSyntax: z.string().max(200).default(""),
  platformCodeSyntax: platformCodeSyntaxSchema.optional(),
  scopes: z.array(z.enum(variableProperties)).default([]),
  values: z.record(id, variableValueSchema),
});
export const reusableStyleSchema = z.object({
  sourceArchived: z.literal(true).optional(),
  id,
  name: z.string().min(1).max(200),
  kind: z.enum(["paint", "stroke", "text", "effect", "grid"]),
  description: z.string().max(2000).default(""),
  properties: styleSchema.partial(),
  bindings: z.partialRecord(z.enum(variableProperties), id).default({}),
});
export const designSystemSchema = z.object({
  collections: z.record(id, collectionSchema),
  variables: z.record(id, variableSchema),
  styles: z.record(id, reusableStyleSchema),
  activeModes: z.record(id, id),
});
export type DesignSystem = z.infer<typeof designSystemSchema>;
export type DesignVariable = z.infer<typeof variableSchema>;
export type VariableValue = z.infer<typeof variableValueSchema>;
export type ReusableStyle = z.infer<typeof reusableStyleSchema>;
export const emptyDesignSystem = (): DesignSystem => ({
  collections: {},
  variables: {},
  styles: {},
  activeModes: {},
});

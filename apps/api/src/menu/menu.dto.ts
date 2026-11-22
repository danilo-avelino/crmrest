import { z } from "zod";

const name = z.string().trim().min(1).max(120);
const text = z.string().trim().max(2_000);
const cents = z.number().int().min(0).max(100_000_00);
const tagList = z
  .array(z.string().trim().min(1).max(60))
  .max(40)
  .transform((list) => [...new Set(list)]);
const ids = z.array(z.uuid()).max(500);

export const CategoryRequest = z.object({
  name,
  description: text.transform((value) => value || null).nullish(),
  active: z.boolean().optional(),
  allowsHalf: z.boolean().optional(),
  halfPricing: z.enum(["MAX", "AVERAGE", "SUM"]).optional(),
});
export type CategoryRequest = z.infer<typeof CategoryRequest>;
export const CategoryPatch = CategoryRequest.partial();

/** Todos os campos que a IA usa para buscar, explicar e recomendar o item. */
export const ItemRequest = z.object({
  categoryId: z.uuid(),
  name,
  description: text.transform((value) => value || null).nullish(),
  priceCents: cents.nullish(), // null: o preço vem dos tamanhos
  photoUrl: z.url().max(2_000).nullish(),
  active: z.boolean().optional(),
  soldOut: z.boolean().optional(),
  allowsHalf: z.boolean().optional(),
  ingredients: tagList.optional(),
  allergens: tagList.optional(),
  servesPeople: z.number().int().min(1).max(100).nullish(),
  tags: tagList.optional(),
  synonyms: tagList.optional(),
  aiNotes: text.transform((value) => value || null).nullish(),
});
export type ItemRequest = z.infer<typeof ItemRequest>;
export const ItemPatch = ItemRequest.partial();

export const OrderRequest = z.object({ ids: ids.min(1) });
export const SoldOutRequest = z.object({ soldOut: z.boolean() });

export const SizesRequest = z.object({
  sizes: z
    .array(z.object({ name, priceCents: cents, active: z.boolean().optional() }))
    .max(20)
    .refine((sizes) => new Set(sizes.map((size) => size.name.toLowerCase())).size === sizes.length, "Tamanhos com o mesmo nome."),
});

export const OptionGroupRequest = z
  .object({
    name,
    minSelect: z.number().int().min(0).max(50).optional(),
    maxSelect: z.number().int().min(1).max(50).optional(),
  })
  .refine((group) => (group.minSelect ?? 0) <= (group.maxSelect ?? 1), { message: "O mínimo não pode passar do máximo.", path: ["minSelect"] });
export const OptionGroupPatch = z
  .object({ name, minSelect: z.number().int().min(0).max(50), maxSelect: z.number().int().min(1).max(50) })
  .partial();

export const OptionRequest = z.object({
  name,
  priceCents: cents.optional(),
  active: z.boolean().optional(),
  soldOut: z.boolean().optional(),
});
export const OptionPatch = OptionRequest.partial();

/** Faixa de horário: weekday 0 (domingo) a 6; minutos desde a meia-noite, fim exclusivo (fim menor que o início vira o dia). */
export const AvailabilityRequest = z.object({
  slots: z
    .array(
      z
        .object({
          weekday: z.number().int().min(0).max(6),
          startMinute: z.number().int().min(0).max(1_439),
          endMinute: z.number().int().min(1).max(1_440),
        })
        .refine((slot) => slot.startMinute !== slot.endMinute, { message: "Início e fim iguais.", path: ["endMinute"] }),
    )
    .max(50),
});

export const PairingsRequest = z.object({ itemIds: ids });
export const OptionGroupLinksRequest = z.object({ groupIds: ids });

export type CategoryPatch = z.infer<typeof CategoryPatch>;
export type ItemPatch = z.infer<typeof ItemPatch>;
export type OrderRequest = z.infer<typeof OrderRequest>;
export type SoldOutRequest = z.infer<typeof SoldOutRequest>;
export type SizesRequest = z.infer<typeof SizesRequest>;
export type OptionGroupRequest = z.infer<typeof OptionGroupRequest>;
export type OptionGroupPatch = z.infer<typeof OptionGroupPatch>;
export type OptionRequest = z.infer<typeof OptionRequest>;
export type OptionPatch = z.infer<typeof OptionPatch>;
export type AvailabilityRequest = z.infer<typeof AvailabilityRequest>;
export type PairingsRequest = z.infer<typeof PairingsRequest>;
export type OptionGroupLinksRequest = z.infer<typeof OptionGroupLinksRequest>;

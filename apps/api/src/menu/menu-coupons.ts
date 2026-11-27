import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { Prisma } from "@dishdesk/database";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { couponStatus, couponUsage, scheduleText } from "../public/menu-coupons.js";
import { MenuService } from "./menu.service.js";

const cents = z.number().int().min(0).max(100_000_00);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const minute = z.number().int().min(0).max(1_439);

const CouponFields = z.object({
  name: z.string().trim().min(1).max(80),
  // Sem código: automático, vale para todos e entra sozinho no carrinho.
  code: z
    .string()
    .trim()
    .max(30)
    .transform((value) => value.toUpperCase().replace(/\s+/g, "") || null)
    .refine((value) => value == null || /^[A-Z0-9_-]+$/.test(value), "Use só letras, números, hífen e sublinhado no código.")
    .nullish(),
  kind: z.enum(["FIXED", "PERCENT", "FREE_DELIVERY"]),
  valueCents: cents.optional(),
  percent: z.number().int().min(1).max(100).optional(),
  maxDiscountCents: cents.nullish(),
  startsOn: day.nullish(),
  endsOn: day.nullish(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  startMinute: minute.nullish(),
  endMinute: minute.nullish(),
  delivery: z.boolean().optional(),
  pickup: z.boolean().optional(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullish(),
  minOrderCents: cents.optional(),
  newCustomersOnly: z.boolean().optional(),
  oncePerCustomer: z.boolean().optional(),
  paymentMethods: z.array(z.enum(["pix", "card", "cash"])).max(3).optional(),
  categoryIds: z.array(z.uuid()).max(200).optional(),
  itemIds: z.array(z.uuid()).max(500).optional(),
  active: z.boolean().optional(),
});

function checkRules(c: Partial<z.infer<typeof CouponFields>>, ctx: z.RefinementCtx) {
  if (c.kind === "FIXED" && !c.valueCents) ctx.addIssue({ code: "custom", path: ["valueCents"], message: "Informe o valor do desconto." });
  if (c.kind === "PERCENT" && !c.percent) ctx.addIssue({ code: "custom", path: ["percent"], message: "Informe a porcentagem do desconto." });
  if (c.startsOn && c.endsOn && c.endsOn < c.startsOn) ctx.addIssue({ code: "custom", path: ["endsOn"], message: "A data final vem antes da inicial." });
  if ((c.startMinute == null) !== (c.endMinute == null)) ctx.addIssue({ code: "custom", path: ["endMinute"], message: "Informe o início e o fim do horário." });
  if (c.startMinute != null && c.startMinute === c.endMinute) ctx.addIssue({ code: "custom", path: ["endMinute"], message: "Início e fim iguais." });
  if (c.delivery === false && c.pickup === false) ctx.addIssue({ code: "custom", path: ["pickup"], message: "Escolha entrega, retirada ou as duas." });
}

export const CouponRequest = CouponFields.superRefine(checkRules);
export type CouponRequest = z.infer<typeof CouponRequest>;

/** Na lista: situação calculada agora, usos e valor descontado. */
function view(row: Prisma.MenuCouponGetPayload<object>, usage: { uses: number; discountCents: number } | undefined, now: Date) {
  const uses = usage?.uses ?? 0;
  return { ...row, uses, discountedCents: usage?.discountCents ?? 0, status: couponStatus(row, uses, now), scheduleText: scheduleText(row) };
}

/** Cupons do cardápio (board N4). A equipe lê; só o administrador altera. */
@Injectable()
export class MenuCouponsService {
  constructor(private readonly menu: MenuService) {}

  list(auth: RequestAuth, tenantId: string, now = new Date()) {
    return this.menu.read(auth, tenantId, async (tx) => {
      const rows = await tx.menuCoupon.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
      const usage = await couponUsage(tx, tenantId, rows.map((r) => r.id));
      return rows.map((row) => view(row, usage.get(row.id), now));
    });
  }

  save(auth: RequestAuth, tenantId: string, id: string | null, body: CouponRequest, now = new Date()) {
    return this.menu.write(auth, tenantId, async (tx) => {
      const categoryIds = body.categoryIds ?? [];
      const itemIds = body.itemIds ?? [];
      if (categoryIds.length && (await tx.menuCategory.count({ where: { tenantId, id: { in: categoryIds } } })) !== new Set(categoryIds).size) {
        throw new NotFoundException("Categoria não encontrada.");
      }
      if (itemIds.length && (await tx.menuItem.count({ where: { tenantId, id: { in: itemIds } } })) !== new Set(itemIds).size) {
        throw new NotFoundException("Item não encontrado.");
      }
      // Os campos fora do tipo escolhido ficam zerados (um cupom de R$ não guarda %).
      const data = {
        ...body,
        code: body.code ?? null,
        valueCents: body.kind === "FIXED" ? (body.valueCents ?? 0) : 0,
        percent: body.kind === "PERCENT" ? (body.percent ?? 0) : 0,
        maxDiscountCents: body.kind === "PERCENT" ? (body.maxDiscountCents ?? null) : null,
        categoryIds: [...new Set(categoryIds)],
        itemIds: [...new Set(itemIds)],
      };
      try {
        let row;
        if (id) {
          if (!(await tx.menuCoupon.findFirst({ where: { id, tenantId }, select: { id: true } }))) throw new NotFoundException("Cupom não encontrado.");
          row = await tx.menuCoupon.update({ where: { id }, data });
        } else {
          row = await tx.menuCoupon.create({ data: { tenantId, ...data } });
        }
        const usage = await couponUsage(tx, tenantId, [row.id]);
        return view(row, usage.get(row.id), now);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new BadRequestException("Já existe um cupom com esse código.");
        throw error;
      }
    });
  }

  /** Liga ou desliga sem mexer nas regras (a caixa da lista). */
  setActive(auth: RequestAuth, tenantId: string, id: string, active: boolean, now = new Date()) {
    return this.menu.write(auth, tenantId, async (tx) => {
      if (!(await tx.menuCoupon.findFirst({ where: { id, tenantId }, select: { id: true } }))) throw new NotFoundException("Cupom não encontrado.");
      const row = await tx.menuCoupon.update({ where: { id }, data: { active } });
      const usage = await couponUsage(tx, tenantId, [id]);
      return view(row, usage.get(id), now);
    });
  }

  remove(auth: RequestAuth, tenantId: string, id: string) {
    return this.menu.write(auth, tenantId, async (tx) => {
      if (!(await tx.menuCoupon.findFirst({ where: { id, tenantId }, select: { id: true } }))) throw new NotFoundException("Cupom não encontrado.");
      await tx.menuCoupon.delete({ where: { id } });
    });
  }
}

const uuid = (param: string) => Param(param, ParseUUIDPipe);
const ActiveRequest = z.object({ active: z.boolean() });

@Controller("menu/:tenantId/coupons")
export class MenuCouponsController {
  constructor(private readonly coupons: MenuCouponsService) {}

  @Get()
  list(@uuid("tenantId") tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.coupons.list(auth, tenantId);
  }

  @Post()
  create(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(CouponRequest)) body: CouponRequest, @CurrentAuth() auth: RequestAuth) {
    return this.coupons.save(auth, tenantId, null, body);
  }

  @Patch(":id")
  update(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Body(new ZodPipe(CouponRequest)) body: CouponRequest, @CurrentAuth() auth: RequestAuth) {
    return this.coupons.save(auth, tenantId, id, body);
  }

  @Patch(":id/active")
  setActive(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Body(new ZodPipe(ActiveRequest)) body: z.infer<typeof ActiveRequest>, @CurrentAuth() auth: RequestAuth) {
    return this.coupons.setActive(auth, tenantId, id, body.active);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.coupons.remove(auth, tenantId, id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import {
  AvailabilityRequest,
  BulkItemsRequest,
  CategoryPatch,
  CategoryRequest,
  ItemPatch,
  ItemRequest,
  OptionGroupLinksRequest,
  OptionGroupPatch,
  OptionGroupRequest,
  OptionPatch,
  OptionRequest,
  OrderRequest,
  PairingsRequest,
  SizesRequest,
  SoldOutRequest,
} from "./menu.dto.js";
import { MenuService } from "./menu.service.js";

const uuid = (name: string) => Param(name, ParseUUIDPipe);

/**
 * Cardápio no painel (módulo MENU): `/menu/:tenantId/...`. A equipe lê; só o administrador altera. Sem o módulo ligado
 * no restaurante tudo responde 403.
 */
@Controller("menu/:tenantId")
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get()
  tree(@uuid("tenantId") tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.tree(auth, tenantId);
  }

  /** Mais vendidos: `?days=30&categoryId=...&limit=10`. */
  @Get("top-items")
  top(
    @uuid("tenantId") tenantId: string,
    @CurrentAuth() auth: RequestAuth,
    @Query("days", new ParseIntPipe({ optional: true })) days = 30,
    @Query("limit", new ParseIntPipe({ optional: true })) limit = 10,
    @Query("categoryId") categoryId?: string,
  ) {
    return this.menu.top(auth, tenantId, categoryId, Math.min(Math.max(days, 1), 365), Math.min(Math.max(limit, 1), 100));
  }

  // ---- categorias ----

  @Post("categories")
  createCategory(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(CategoryRequest)) body: CategoryRequest, @CurrentAuth() auth: RequestAuth) {
    return this.menu.createCategory(auth, tenantId, body);
  }

  @Put("categories/order")
  @HttpCode(204)
  reorderCategories(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(OrderRequest)) body: OrderRequest, @CurrentAuth() auth: RequestAuth) {
    return this.menu.reorderCategories(auth, tenantId, body.ids);
  }

  @Patch("categories/:id")
  updateCategory(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(CategoryPatch)) body: CategoryPatch,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.updateCategory(auth, tenantId, id, body);
  }

  @Delete("categories/:id")
  @HttpCode(204)
  deleteCategory(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.deleteCategory(auth, tenantId, id);
  }

  @Put("categories/:id/availability")
  setCategoryAvailability(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(AvailabilityRequest)) body: AvailabilityRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.setCategoryAvailability(auth, tenantId, id, body);
  }

  @Put("categories/:id/items/order")
  @HttpCode(204)
  reorderItems(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(OrderRequest)) body: OrderRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.reorderItems(auth, tenantId, id, body.ids);
  }

  // ---- itens ----

  @Post("items")
  createItem(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(ItemRequest)) body: ItemRequest, @CurrentAuth() auth: RequestAuth) {
    return this.menu.createItem(auth, tenantId, body);
  }

  /** Edição em planilha (N2). */
  @Patch("items")
  bulkUpdateItems(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(BulkItemsRequest)) body: BulkItemsRequest, @CurrentAuth() auth: RequestAuth) {
    return this.menu.bulkUpdateItems(auth, tenantId, body);
  }

  @Patch("items/:id")
  updateItem(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(ItemPatch)) body: ItemPatch,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.updateItem(auth, tenantId, id, body);
  }

  @Delete("items/:id")
  @HttpCode(204)
  deleteItem(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.deleteItem(auth, tenantId, id);
  }

  @Post("items/:id/duplicate")
  duplicateItem(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.duplicateItem(auth, tenantId, id);
  }

  @Put("items/:id/sold-out")
  setSoldOut(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(SoldOutRequest)) body: SoldOutRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.setSoldOut(auth, tenantId, id, body.soldOut);
  }

  @Post("items/:id/archive")
  @HttpCode(200)
  archive(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.setActive(auth, tenantId, id, false);
  }

  @Post("items/:id/unarchive")
  @HttpCode(200)
  unarchive(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.setActive(auth, tenantId, id, true);
  }

  @Put("items/:id/sizes")
  setSizes(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(SizesRequest)) body: SizesRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.setSizes(auth, tenantId, id, body);
  }

  @Put("items/:id/availability")
  setItemAvailability(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(AvailabilityRequest)) body: AvailabilityRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.setItemAvailability(auth, tenantId, id, body);
  }

  @Put("items/:id/pairings")
  setPairings(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(PairingsRequest)) body: PairingsRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.setPairings(auth, tenantId, id, body.itemIds);
  }

  @Put("items/:id/option-groups")
  setItemOptionGroups(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(OptionGroupLinksRequest)) body: OptionGroupLinksRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.setItemOptionGroups(auth, tenantId, id, body.groupIds);
  }

  @Post("items/:id/option-groups/:groupId")
  @HttpCode(200)
  linkOptionGroup(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @uuid("groupId") groupId: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.linkOptionGroup(auth, tenantId, id, groupId);
  }

  @Delete("items/:id/option-groups/:groupId")
  @HttpCode(204)
  unlinkOptionGroup(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @uuid("groupId") groupId: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.unlinkOptionGroup(auth, tenantId, id, groupId);
  }

  // ---- grupos de complementos ----

  @Post("option-groups")
  createOptionGroup(
    @uuid("tenantId") tenantId: string,
    @Body(new ZodPipe(OptionGroupRequest)) body: OptionGroupRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.createOptionGroup(auth, tenantId, body);
  }

  @Put("option-groups/order")
  @HttpCode(204)
  reorderOptionGroups(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(OrderRequest)) body: OrderRequest, @CurrentAuth() auth: RequestAuth) {
    return this.menu.reorderOptionGroups(auth, tenantId, body.ids);
  }

  @Patch("option-groups/:id")
  updateOptionGroup(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(OptionGroupPatch)) body: OptionGroupPatch,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.updateOptionGroup(auth, tenantId, id, body);
  }

  @Delete("option-groups/:id")
  @HttpCode(204)
  deleteOptionGroup(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.deleteOptionGroup(auth, tenantId, id);
  }

  @Post("option-groups/:id/options")
  createOption(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(OptionRequest)) body: OptionRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.createOption(auth, tenantId, id, body);
  }

  @Patch("options/:id")
  updateOption(
    @uuid("tenantId") tenantId: string,
    @uuid("id") id: string,
    @Body(new ZodPipe(OptionPatch)) body: OptionPatch,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.menu.updateOption(auth, tenantId, id, body);
  }

  @Delete("options/:id")
  @HttpCode(204)
  deleteOption(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    return this.menu.deleteOption(auth, tenantId, id);
  }
}

import {
  type ContactDetail,
  type ContactFilterOptions,
  ContactListQuery,
  type ContactPage,
  type ContactSummary,
  ContactPairRequest,
  type ConversationListItem,
  type DuplicatePair,
  type OrderDto,
  UpdateContactRequest,
} from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ContactsService } from "./contacts.service.js";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@Query(new ZodPipe(ContactListQuery)) query: ContactListQuery, @CurrentAuth() auth: RequestAuth): Promise<ContactPage> {
    return this.contacts.list(auth, query);
  }

  @Get("filters")
  filterOptions(@CurrentAuth() auth: RequestAuth): Promise<ContactFilterOptions> {
    return this.contacts.filterOptions(auth);
  }

  @Get("summary")
  summary(@CurrentAuth() auth: RequestAuth): Promise<ContactSummary> {
    return this.contacts.summary(auth);
  }

  @Get("duplicates")
  duplicates(@CurrentAuth() auth: RequestAuth): Promise<DuplicatePair[]> {
    return this.contacts.duplicates(auth);
  }

  @Post("duplicates/dismiss")
  @HttpCode(204)
  async dismissDuplicate(
    @Body(new ZodPipe(ContactPairRequest)) body: ContactPairRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    await this.contacts.dismissDuplicate(auth, body.contactIds);
  }

  @Post("merge")
  @HttpCode(200)
  merge(@Body(new ZodPipe(ContactPairRequest)) body: ContactPairRequest, @CurrentAuth() auth: RequestAuth) {
    return this.contacts.merge(auth, body.contactIds);
  }

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<ContactDetail> {
    return this.contacts.get(auth, id);
  }

  @Patch(":id")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateContactRequest)) body: UpdateContactRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<ContactDetail> {
    return this.contacts.update(auth, id, body);
  }

  @Get(":id/conversations")
  conversations(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<ConversationListItem[]> {
    return this.contacts.conversations(auth, id);
  }

  @Get(":id/orders")
  orders(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<OrderDto[]> {
    return this.contacts.orders(auth, id);
  }

  @Post(":id/cpf")
  @HttpCode(200)
  revealCpf(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth) {
    return this.contacts.revealCpf(auth, id);
  }

  @Get(":id/export")
  exportData(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth) {
    return this.contacts.exportData(auth, id);
  }

  @Post(":id/anonymize")
  @HttpCode(200)
  anonymize(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<ContactDetail> {
    return this.contacts.anonymize(auth, id);
  }
}
